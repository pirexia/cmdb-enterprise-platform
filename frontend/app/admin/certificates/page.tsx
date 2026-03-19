"use client";

import { useState } from "react";
import AppShell from "@/components/AppShell";
import { Shield, Download, Upload, Loader2, CheckCircle, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

export default function CertificatesPage() {
  // CSR Generation
  const [cn, setCn] = useState("");
  const [organization, setOrganization] = useState("");
  const [organizationalUnit, setOrganizationalUnit] = useState("");
  const [country, setCountry] = useState("ES");
  const [state, setState] = useState("");
  const [generatingCSR, setGeneratingCSR] = useState(false);
  const [csrResult, setCsrResult] = useState<string | null>(null);

  // Certificate Upload
  const [certContent, setCertContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");

  const [error, setError] = useState<string | null>(null);

  const handleGenerateCSR = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingCSR(true);
    setError(null);
    setCsrResult(null);

    try {
      const response = await apiFetch("/api/admin/certificates/csr", {
        method: "POST",
        body: JSON.stringify({ cn, o: organization, ou: organizationalUnit, c: country, st: state }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to generate CSR");

      setCsrResult(data.csr);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error generating CSR");
    } finally {
      setGeneratingCSR(false);
    }
  };

  const handleDownloadCSR = () => {
    if (!csrResult) return;
    const blob = new Blob([csrResult], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "server.csr";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUploadCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploading(true);
    setError(null);
    setUploadSuccess(false);
    setUploadMessage("");

    try {
      const response = await apiFetch("/api/admin/certificates/upload", {
        method: "POST",
        body: JSON.stringify({ certificate: certContent }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to upload certificate");

      setUploadSuccess(true);
      setUploadMessage(data.message || "Certificate uploaded successfully");
      setCertContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error uploading certificate");
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setCertContent(content);
    };
    reader.readAsText(file);
  };

  return (
    <AppShell>
      <div className="p-8">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="h-7 w-7 text-indigo-600" />
            <h1 className="text-3xl font-bold text-slate-800">SSL/TLS Certificate Management</h1>
          </div>
          <p className="text-sm text-slate-500">
            Generate Certificate Signing Requests (CSR) and upload signed certificates from your CA.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* CSR Generation */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                <Download className="h-5 w-5 text-indigo-600" />
                1. Generate CSR
              </h2>
              <p className="text-xs text-slate-500 mt-1">Create a Certificate Signing Request for your CA</p>
            </div>

            <form onSubmit={handleGenerateCSR} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                  Common Name (CN) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="lx-gest01p.yourdomain.com"
                  value={cn}
                  onChange={(e) => setCn(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
                <p className="text-xs text-slate-400 mt-1">Server FQDN or IP address</p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                  Organization (O)
                </label>
                <input
                  type="text"
                  placeholder="Your Company Name"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    Country (C)
                  </label>
                  <input
                    type="text"
                    maxLength={2}
                    placeholder="ES"
                    value={country}
                    onChange={(e) => setCountry(e.target.value.toUpperCase())}
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    State/Province (ST)
                  </label>
                  <input
                    type="text"
                    placeholder="Madrid"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                  Organizational Unit (OU)
                </label>
                <input
                  type="text"
                  placeholder="IT Department"
                  value={organizationalUnit}
                  onChange={(e) => setOrganizationalUnit(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>

              <button
                type="submit"
                disabled={generatingCSR || !cn}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {generatingCSR ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {generatingCSR ? "Generating..." : "Generate CSR"}
              </button>
            </form>

            {csrResult && (
              <div className="px-6 pb-6">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <p className="text-sm font-semibold text-green-700">CSR Generated Successfully</p>
                  </div>
                  <textarea
                    readOnly
                    value={csrResult}
                    className="w-full rounded border border-green-300 bg-white px-3 py-2 font-mono text-xs text-slate-700 h-32 resize-none"
                  />
                  <button
                    onClick={handleDownloadCSR}
                    className="mt-3 flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors"
                  >
                    <Download className="h-4 w-4" />
                    Download server.csr
                  </button>
                  <p className="text-xs text-green-600 mt-2">
                    Send this CSR to your Certificate Authority for signing.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Certificate Upload */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                <Upload className="h-5 w-5 text-indigo-600" />
                2. Upload Signed Certificate
              </h2>
              <p className="text-xs text-slate-500 mt-1">Install the certificate signed by your CA</p>
            </div>

            <form onSubmit={handleUploadCertificate} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                  Certificate File (.crt / .pem)
                </label>
                <input
                  type="file"
                  accept=".crt,.pem,.cer"
                  onChange={handleFileUpload}
                  className="w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                />
                <p className="text-xs text-slate-400 mt-1">Or paste the PEM content below</p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                  Certificate Content (PEM format)
                </label>
                <textarea
                  placeholder="-----BEGIN CERTIFICATE-----&#10;MIIDXTCCAkWgAwIBAgIJAKZ...&#10;-----END CERTIFICATE-----"
                  value={certContent}
                  onChange={(e) => setCertContent(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 h-40 resize-none focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>

              <button
                type="submit"
                disabled={uploading || !certContent}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? "Uploading..." : "Upload Certificate"}
              </button>
            </form>

            {uploadSuccess && uploadMessage && (
              <div className="px-6 pb-6">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <p className="text-sm font-semibold text-green-700">Certificate Uploaded</p>
                  </div>
                  <p className="text-sm text-green-600 mb-3">{uploadMessage}</p>
                  <div className="rounded bg-green-100 border border-green-300 px-3 py-2 font-mono text-xs text-green-800">
                    docker compose -f docker-compose.prod.yml restart backend
                  </div>
                  <p className="text-xs text-green-600 mt-2">
                    Run this command to apply the new certificate.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Instructions */}
        <div className="mt-8 rounded-xl border border-blue-200 bg-blue-50 px-6 py-5">
          <h3 className="text-sm font-semibold text-blue-800 mb-3">Certificate Management Workflow</h3>
          <ol className="text-sm text-blue-700 space-y-2 list-decimal list-inside">
            <li>Fill in the CSR form with your server details and click "Generate CSR"</li>
            <li>Download the generated CSR file and send it to your Certificate Authority (CA)</li>
            <li>When you receive the signed certificate from your CA, upload it using the form above</li>
            <li>Restart the backend container to apply the new certificate</li>
            <li>Verify the certificate is active: <code className="bg-blue-100 px-1.5 py-0.5 rounded font-mono text-xs">openssl s_client -connect localhost:3000</code></li>
          </ol>
        </div>
      </div>
    </AppShell>
  );
}
