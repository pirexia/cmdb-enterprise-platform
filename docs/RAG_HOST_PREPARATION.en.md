# RAG Subsystem — Host Server Preparation

**Applies to:** CMDB Enterprise Platform v2.3+
**Target OS:** Red Hat Enterprise Linux 9 on VMware ESXi 8.0
**Last validated:** 2026-05-20 on lx-gest01p.svc.int
**Status:** Validated in production: 2026-05-20

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Recommended Sizing](#2-recommended-sizing)
3. [vCenter / vSphere Configuration](#3-vcenter--vsphere-configuration)
4. [Verifying AMX Inside the Guest](#4-verifying-amx-inside-the-guest)
5. [Storage Extension (LVM)](#5-storage-extension-lvm)
6. [System Update and Podman Installation](#6-system-update-and-podman-installation)
7. [Kernel Tuning and System Limits](#7-kernel-tuning-and-system-limits)
8. [Firewall](#8-firewall)
9. [Container Runtime Verification (Podman)](#9-container-runtime-verification-podman)
10. [Persistent Directory Structure](#10-persistent-directory-structure)
11. [Final Verification](#11-final-verification)
- [Appendix A — SELinux Considerations](#appendix-a--selinux-considerations)
- [Appendix B — LLM Model Sizing](#appendix-b--llm-model-sizing)
- [Appendix C — Troubleshooting](#appendix-c--troubleshooting)
- [Appendix D — Regulatory Controls](#appendix-d--regulatory-controls)

---

## 1. Prerequisites

Before starting, verify that all of the following conditions are met:

1. Root or sudo access to the target VM.
2. The VM is hosted on a VMware ESXi 8.0.3 or later host with an Intel Xeon "Sapphire Rapids" CPU (Gold 6526Y or equivalent).
3. The VM has hardware version v21 or later (required to expose AMX to the guest).
4. An active RHEL 9 subscription (`subscription-manager status` reports `Current`).
5. Internet access from the VM to download packages from RHEL repositories and container images.
6. An additional disk of at least 150 GiB available and visible within the VM (used in §5).
7. The installer has already completed steps §0–§3 of `SYSADMIN_MANUAL.en.md` for the base platform.

---

## 2. Recommended Sizing

The table below describes three deployment profiles. The "Recommended" profile corresponds to the validated server (`lx-gest01p.svc.int`).

| Parameter              | Minimum (PoC)               | Recommended (CPU+AMX)             | Optimal (GPU)                          |
|------------------------|-----------------------------|-----------------------------------|----------------------------------------|
| vCPU                   | 8                           | 12                                | 8                                      |
| RAM                    | 16 GiB                      | 32 GiB                            | 24 GiB                                 |
| Total disk             | 100 GB                      | 250 GB                            | 200 GB                                 |
| Accelerator            | No GPU                      | No GPU (AMX enabled)              | NVIDIA T4 / A10 >= 8 GB VRAM           |
| LLM model              | qwen2.5:3b-instruct-q4_K_M  | qwen2.5:7b-instruct-q4_K_M        | qwen2.5:7b-instruct-q4_K_M             |
| Concurrent users       | 1                           | 5–10                              | 20+                                    |
| Approximate throughput | ~25–35 tok/s                | ~12–18 tok/s, TTFT 1–2 s          | ~50–80 tok/s (full GPU offload)        |

> **Performance note:** With AMX enabled (recommended profile), throughput is ~12–18 tok/s with a time-to-first-token (TTFT) of 1–2 seconds and a full response in ~10–18 seconds. Without AMX (AVX-512 only), throughput drops to ~6–9 tok/s and a full response takes ~18–35 seconds.

---

## 3. vCenter / vSphere Configuration

These steps are performed from the vCenter console. The VM may be powered off or, if hot-add is enabled, powered on for CPU/RAM changes. The `cpuid.enableAMX` parameter requires the VM to be powered off.

1. Open vCenter, select the VM, and click **Edit Settings**.
2. Upgrade the hardware version to **v21**:
   - Navigate to **Configuration Parameters** (Advanced configuration parameters).
   - Add or modify: `vmx.version = "vmx-21"`.
   - This step requires the VM to be powered off.
3. Configure CPU resources:
   - Set **12 vCPU** (or the number defined in §2 for the chosen profile).
   - Enable the option **"Expose hardware CPU to guest OS"** (host CPU passthrough). This option forwards physical CPU flags directly to the guest, including AMX.
4. Configure memory: set **32 GiB** (or the value for the chosen profile).
5. Add a new disk of **150 GiB**:
   - Select **Thin Provision** on the same datastore.
   - This disk will be partitioned in §5 into the `containers` and `cmdbdata` logical volumes.
6. Enable AMX explicitly:
   - In **Configuration Parameters**, add: `cpuid.enableAMX = "TRUE"`.
7. Save all changes and power on the VM.

---

## 4. Verifying AMX Inside the Guest

Once the VM has booted with the changes from §3, verify that AMX is visible within the OS.

1. Check for the `amx_tile` flag in `/proc/cpuinfo`:

```bash
grep -c amx_tile /proc/cpuinfo && echo "AMX active: OK" || echo "AMX not detected — review §3"
```

2. List all available AMX flags:

```bash
lscpu | grep -E 'amx_tile|amx_bf16|amx_int8'
```

   Expected output includes all three flags: `amx_tile`, `amx_bf16`, `amx_int8`. The presence of `amx_bf16` is particularly relevant for BF16 floating-point inference.

3. If AMX is not present but the host has a Sapphire Rapids CPU, follow these corrective steps:
   - Power off the VM completely (do not suspend).
   - In vCenter: **Edit** → **Configuration Parameters** → confirm that `cpuid.enableAMX = "TRUE"` is present and saved.
   - Verify that the hardware version is v21 or later.
   - Check the cluster EVC mode (if applicable): it must be **Sapphire Rapids** or higher, or EVC must be disabled. A lower EVC mode masks advanced CPU flags even if the host supports them.
   - Power on the VM and repeat the commands above.

---

## 5. Storage Extension (LVM)

The following sequence was validated in production on `lx-gest01p.svc.int`. It creates two dedicated logical volumes: `containers` (100 GB, mount point `/var/lib/containers`) and `cmdbdata` (70 GB, mount point `/opt/cmdb-data`).

> **Caution:** The `lvremove` commands are destructive. Carefully verify that each listed LV has no active filesystem or mount point before removing it.

1. Back up the volume group configuration:

```bash
vgcfgbackup vg00 -f /root/vg00-backup-$(date +%F).cfg
```

2. Verify that the LVs to be removed are truly orphaned (no active filesystem, no mount). Run for each LV:

```bash
for lv in lv_root lv_home lv_usr lv_var lv_opt lv_tmp; do
  wipefs -n /dev/vg00/$lv 2>/dev/null
  blkid /dev/vg00/$lv 2>/dev/null
done
```

   If all commands return empty output (no UUID, no filesystem type), the LVs are orphaned and may be safely removed.

3. Remove the orphaned LVs to free space in the VG:

```bash
lvremove -y /dev/vg00/lv_root /dev/vg00/lv_home /dev/vg00/lv_usr \
            /dev/vg00/lv_var  /dev/vg00/lv_opt  /dev/vg00/lv_tmp
```

4. Identify the new disk added in §3 (adjust the device name according to the output of `lsblk`):

```bash
lsblk
# Identify the new disk, typically /dev/sde, with no partition table
```

5. Add the new disk to the existing volume group:

```bash
pvcreate /dev/sde
vgextend vg00 /dev/sde
vgs
```

6. Create the dedicated LVs for the RAG subsystem:

```bash
lvcreate -L 100G -n containers vg00
lvcreate -L  70G -n cmdbdata   vg00
```

7. Format both LVs with XFS:

```bash
mkfs.xfs -f /dev/vg00/containers
mkfs.xfs -f /dev/vg00/cmdbdata
```

8. Create the mount points:

```bash
mkdir -p /var/lib/containers /opt/cmdb-data
```

9. Persist the mounts in `/etc/fstab` using UUIDs (immune to device reordering):

```bash
UUID_CONT=$(blkid -s UUID -o value /dev/vg00/containers)
UUID_DATA=$(blkid -s UUID -o value /dev/vg00/cmdbdata)
cp /etc/fstab /etc/fstab.bak.$(date +%F)
echo "UUID=$UUID_CONT /var/lib/containers xfs defaults,nofail 0 2" >> /etc/fstab
echo "UUID=$UUID_DATA /opt/cmdb-data      xfs defaults,nofail 0 2" >> /etc/fstab
```

10. Apply the new mounts and verify:

```bash
mount -a && systemctl daemon-reload && mount -a
df -h | grep -E 'containers|cmdb-data'
```

   The output must show both mount points at the correct size (~107 GiB for `containers` and ~75 GiB for `cmdb-data`, including XFS metadata).

---

## 6. System Update and Podman Installation

1. Verify that the RHEL subscription is active:

```bash
subscription-manager status
```

2. Update all system packages:

```bash
dnf -y update
```

3. Install Podman and container support tools:

```bash
dnf -y install podman podman-compose podman-docker buildah skopeo \
              crun fuse-overlayfs slirp4netns container-selinux \
              policycoreutils-python-utils git jq curl tar bash-completion
```

4. Verify the installed versions:

```bash
podman --version   # Must be >= 4.9
podman-compose --version
```

   Podman >= 4.9 is required for full `podman-compose` support with internal networks and bind mounts using SELinux labels (`:Z`).

---

## 7. Kernel Tuning and System Limits

The following parameters optimise the kernel for LLM inference workloads (large virtual memory allocations, high file descriptor concurrency).

1. Create the kernel parameter file:

```bash
cat > /etc/sysctl.d/99-cmdb-rag.conf <<'EOF'
vm.max_map_count     = 262144
vm.overcommit_memory = 1
vm.swappiness        = 10
fs.file-max          = 524288
net.core.somaxconn   = 4096
EOF
```

2. Apply the parameters without rebooting:

```bash
sysctl --system
```

3. Create the system limits file for file descriptors and processes:

```bash
cat > /etc/security/limits.d/99-cmdb-rag.conf <<'EOF'
*  soft  nofile  131072
*  hard  nofile  131072
*  soft  nproc   65535
*  hard  nproc   65535
EOF
```

   Limits from `limits.d` apply on the next login session. To apply them in the current session, use `ulimit -n 131072`.

---

## 8. Firewall

1. Install and enable `firewalld` if not already present:

```bash
dnf -y install firewalld
systemctl enable --now firewalld
```

2. Permanently allow the required services:

```bash
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=ssh
```

3. Reload rules and verify the result:

```bash
firewall-cmd --reload
firewall-cmd --list-all
```

   The output of `--list-all` must show `services: cockpit dhcpv6-client http https ssh` (or another set according to site policy). Traffic between containers travels over the internal Podman network and requires no additional firewall rules.

---

## 9. Container Runtime Verification (Podman)

The default `graphRoot` on RHEL 9 is `/var/lib/containers/storage`. By having mounted the `containers` LV on `/var/lib/containers` in §5, Podman transparently uses the new volume with no additional configuration.

1. Verify Podman storage configuration:

```bash
podman info | grep -E 'graphRoot|graphRootAllocated|driver'
```

   Expected output:
   ```
   graphRoot: /var/lib/containers/storage
   graphRootAllocated: ~107 GB
   graphDriver: overlay
   ```

   The `graphRootAllocated` value reflects the size of the `containers` LV plus XFS filesystem metadata.

2. If `graphRoot` points to a different path, verify that the LV mount is active (`mount | grep containers`) and that `podman info` is run as root.

---

## 10. Persistent Directory Structure

Create the directory structure under `/opt/cmdb-data` that will be used by the RAG subsystem services (Ollama, pgvector, uploaded documents, backups):

```bash
mkdir -p /opt/cmdb-data/{repo,documents,postgres,ollama-models,backups}
ls -la /opt/cmdb-data/
```

| Directory                       | Purpose                                                    |
|---------------------------------|------------------------------------------------------------|
| `/opt/cmdb-data/repo`           | Platform repository clone                                  |
| `/opt/cmdb-data/documents`      | Uploaded files awaiting RAG indexing                       |
| `/opt/cmdb-data/postgres`       | PostgreSQL persistent volume with pgvector extension       |
| `/opt/cmdb-data/ollama-models`  | LLM models downloaded by Ollama                            |
| `/opt/cmdb-data/backups`        | Scheduled database backups                                 |

---

## 11. Final Verification

Run the following checks in order before proceeding with the RAG subsystem installation.

1. Verify that Podman is working correctly with the new storage:

```bash
podman pull docker.io/library/alpine:latest
podman run --rm alpine echo "podman OK on $(uname -m)"
podman rmi alpine
```

2. Verify the kernel parameters applied in §7:

```bash
sysctl vm.max_map_count vm.overcommit_memory fs.file-max
```

3. Verify the limits for the current session (open a new session or apply with `ulimit`):

```bash
ulimit -n   # Must show 131072
ulimit -u   # Must show 65535
```

4. Verify available space on both LVs:

```bash
df -h /var/lib/containers /opt/cmdb-data
```

5. Check whether the system requires a reboot after the updates in §6:

```bash
needs-restarting -r || echo "no reboot required"
```

   If `needs-restarting -r` exits with code 1 (reboot required), reboot the VM before proceeding with the RAG subsystem installation.

---

## Appendix A — SELinux Considerations

On the validated server (`lx-gest01p.svc.int`) SELinux is configured in `Disabled` mode. The bind mounts defined in the RAG subsystem compose file include the `:Z` label; with SELinux disabled this label is a no-op and causes no errors or incorrect behaviour.

**Hardening backlog (ISO 27001 A.8.7):** Re-enabling SELinux in `Enforcing` mode requires the following additional steps before taking the subsystem to production in environments with a strict security policy:

1. Switch to permissive mode first to identify denials without blocking the service:

```bash
setenforce 0
```

2. Start the full RAG subsystem and collect AVC denials:

```bash
ausearch -m avc -ts recent | audit2allow -M cmdb-rag
```

3. Install the generated policy module:

```bash
semodule -i cmdb-rag.pp
```

4. Apply the correct file contexts to the persistent directories:

```bash
semanage fcontext -a -t container_file_t "/opt/cmdb-data(/.*)?"
semanage fcontext -a -t container_file_t "/var/lib/containers(/.*)?"
restorecon -Rv /opt/cmdb-data /var/lib/containers
```

5. Switch to `Enforcing` mode and verify that the subsystem continues to function:

```bash
setenforce 1
```

---

## Appendix B — LLM Model Sizing

The table below summarises the models validated with Ollama on the "Recommended" profile (12 vCPU, 32 GiB, AMX enabled).

| Model                             | Download size | RAM used  | tok/s (CPU+AMX, 12 vCPU) | Use case                                              |
|-----------------------------------|---------------|-----------|---------------------------|-------------------------------------------------------|
| bge-m3                            | 1.2 GB        | ~1 GB     | — (embeddings only)       | Multilingual semantic indexing (ES/EN/DE/PT/FR/IT)    |
| qwen2.5:3b-instruct-q4_K_M        | 2.0 GB        | ~2.5 GB   | ~25–35 tok/s              | Low-resource host or high-concurrency scenarios       |
| qwen2.5:7b-instruct-q4_K_M        | 4.7 GB        | ~6 GB     | ~12–18 tok/s              | **Recommended** — strong quality in both ES and EN   |
| llama3.1:8b-instruct-q4_K_M       | 4.9 GB        | ~6 GB     | ~10–15 tok/s              | English-language alternative                          |

> **GPU note:** With an NVIDIA T4 (16 GB VRAM) or A10 (24 GB VRAM) and full GPU offload, throughput is approximately 3–5 times higher than the CPU+AMX figures shown above.

The `bge-m3` model is used exclusively to generate vector embeddings during document indexing. It does not generate text. The instruction models (`qwen2.5`, `llama3.1`) handle response generation in the RAG pipeline.

---

## Appendix C — Troubleshooting

### AMX not present in `/proc/cpuinfo`

1. Verify that the VM is fully powered off (not suspended).
2. In vCenter, confirm that `cpuid.enableAMX = "TRUE"` is saved in Configuration Parameters.
3. Verify that the VM hardware version is v21 or later.
4. Check the cluster EVC mode: it must be **Sapphire Rapids** or higher, or EVC must be disabled. A lower EVC baseline masks AMX instructions even if the host supports them.
5. Power on the VM and repeat `grep -c amx_tile /proc/cpuinfo`.

### Podman not using the new LV

1. Verify that the LV is mounted at the correct path:

```bash
mount | grep containers
```

2. If not mounted, check the entry in `/etc/fstab` and run `mount -a`.
3. Confirm that `podman info | grep graphRoot` points to `/var/lib/containers/storage`.

### Ollama not responding

1. Review the container logs:

```bash
podman logs cmdb-ollama
```

2. Verify that `OLLAMA_BASE_URL=http://ollama:11434` is correctly set in the platform `.env` file.
3. Confirm the container is in a `running` state:

```bash
podman ps | grep ollama
```

### LLM responses are very slow

1. Check that the model is loaded in memory (avoiding a reload on every request):

```bash
podman exec cmdb-ollama ollama ps
```

2. Verify that AMX is still active after a potential reboot:

```bash
grep -c amx_tile /proc/cpuinfo
```

3. Review system load during inference:

```bash
top -bn1 | head -20
```

### "no space left on device" error

```bash
df -h /var/lib/containers
df -h /opt/cmdb-data
```

If either LV is at 100% capacity, it can be extended online with `lvextend -L +50G /dev/vg00/containers && xfs_growfs /var/lib/containers` (XFS supports online growth).

---

## Appendix D — Regulatory Controls

The following table maps the steps in this guide to controls from the applicable regulatory frameworks.

| Framework            | Control                              | Requirement description                                                     | Related section in this guide           |
|----------------------|--------------------------------------|-----------------------------------------------------------------------------|------------------------------------------|
| ISO 27001:2022       | A.8.7 — Protection against malware   | Enable SELinux Enforcing in production environments                         | Appendix A                               |
| ISO 27001:2022       | A.8.9 — Configuration management    | Document and version all applied system parameters                          | §7, §8                                   |
| ISO 27001:2022       | A.8.31 — Separation of environments  | Use dedicated LVs for production data vs. operating system                 | §5                                       |
| NIS2 (EU 2022/2555)  | Art. 21 — Technical measures         | Apply security measures proportionate to risk (sysctl, limits)             | §7                                       |
| NIS2 (EU 2022/2555)  | Art. 21 — Continuity                 | The RAG subsystem must be independently disableable without affecting the base platform | §3, §5             |
| ISO 22301:2019       | §8.4 — RTO                           | A pre-built container image enables RTO < 15 min from a clean `podman pull` | §9, §10                                 |
| ISO 22301:2019       | §8.4 — Backups                       | The `/opt/cmdb-data/backups` directory must be included in the existing backup policy | §10                        |
