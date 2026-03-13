import { PrismaClient, Criticality, Environment, LocationType } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

async function main() {
  console.log('🌱 Starting database seed...');

  // ─── Cleanup (idempotent re-runs) ───────────────────────────────────────────
  await prisma.hardwareCI.deleteMany();
  await prisma.softwareCI.deleteMany();
  await prisma.cI.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.location.deleteMany();
  await prisma.costCenter.deleteMany();
  await prisma.user.deleteMany();
  await prisma.vendor.deleteMany();

  // ─── Auth Users (raw SQL — new password/role cols not in TS types until DLL restart) ──

  const adminHash  = await bcrypt.hash('admin123', BCRYPT_ROUNDS);
  const auditHash  = await bcrypt.hash('audit123', BCRYPT_ROUNDS);
  const genericHash = await bcrypt.hash('cmdb1234', BCRYPT_ROUNDS);

  // admin@cmdb.local — ADMIN
  const adminUser = await prisma.user.create({
    data: { username: 'admin', email: 'admin@cmdb.local' },
  });
  await prisma.$executeRaw`
    UPDATE "users" SET password = ${adminHash}, role = 'ADMIN' WHERE id = ${adminUser.id}::uuid
  `;
  console.log(`✅ User created: admin [ADMIN] (admin@cmdb.local)`);

  // auditor@cmdb.local — VIEWER
  const auditorUser = await prisma.user.create({
    data: { username: 'auditor', email: 'auditor@cmdb.local' },
  });
  await prisma.$executeRaw`
    UPDATE "users" SET password = ${auditHash}, role = 'VIEWER' WHERE id = ${auditorUser.id}::uuid
  `;
  console.log(`✅ User created: auditor [VIEWER] (auditor@cmdb.local)`);

  // Demo users for CI ownership
  const businessOwner = await prisma.user.create({
    data: { username: 'roo.engineer', email: 'roo@cmdb.internal', ssoExternalId: 'sso-roo-001' },
  });
  await prisma.$executeRaw`
    UPDATE "users" SET password = ${genericHash}, role = 'VIEWER' WHERE id = ${businessOwner.id}::uuid
  `;
  console.log(`✅ User created: ${businessOwner.username} [VIEWER]`);

  const technicalLead = await prisma.user.create({
    data: { username: 'andre.lead', email: 'andre@cmdb.internal', ssoExternalId: 'sso-andre-002' },
  });
  await prisma.$executeRaw`
    UPDATE "users" SET password = ${genericHash}, role = 'ADMIN' WHERE id = ${technicalLead.id}::uuid
  `;
  console.log(`✅ User created: ${technicalLead.username} [ADMIN]`);

  // ─── Vendor ──────────────────────────────────────────────────────────────────

  const dell = await prisma.vendor.create({ data: { name: 'Dell Technologies' } });
  console.log(`✅ Vendor: ${dell.name}`);

  // ─── Cost Center ─────────────────────────────────────────────────────────────

  const itOps = await prisma.costCenter.create({ data: { code: 'CC-IT-001', name: 'IT Operations' } });
  console.log(`✅ CostCenter: ${itOps.name}`);

  // ─── Location ────────────────────────────────────────────────────────────────

  const mainDC = await prisma.location.create({
    data: { name: 'Main DataCenter - Madrid', type: LocationType.DATACENTER },
  });
  console.log(`✅ Location: ${mainDC.name}`);

  // ─── CIs ─────────────────────────────────────────────────────────────────────

  const server = await prisma.cI.create({
    data: {
      name: 'PROD-SRV-01 Web Server', apiSlug: 'prod-srv-01',
      criticality: Criticality.HIGH, environment: Environment.PRODUCTION,
      eolDate: new Date('2028-12-31'), eosDate: new Date('2027-06-30'),
      businessOwnerId: businessOwner.id, technicalLeadId: technicalLead.id,
      locationId: mainDC.id, costCenterId: itOps.id,
      hardware: { create: { serialNumber: 'DELL-SN-XK29-0091', model: 'PowerEdge R750', manufacturer: 'Dell' } },
    },
  });
  console.log(`✅ CI: ${server.name}`);

  const dbServer = await prisma.cI.create({
    data: {
      name: 'PROD-DB-01 PostgreSQL', apiSlug: 'prod-db-01',
      criticality: Criticality.MISSION_CRITICAL, environment: Environment.PRODUCTION,
      businessOwnerId: businessOwner.id, technicalLeadId: technicalLead.id,
      locationId: mainDC.id, costCenterId: itOps.id, parentCIId: server.id,
      hardware: { create: { serialNumber: 'DELL-SN-DB-0042', model: 'PowerEdge R640', manufacturer: 'Dell' } },
    },
  });
  console.log(`✅ CI: ${dbServer.name} (child of ${server.name})`);

  const nginxSoftware = await prisma.cI.create({
    data: {
      name: 'NGINX Load Balancer', apiSlug: 'nginx-lb-prod',
      criticality: Criticality.HIGH, environment: Environment.PRODUCTION,
      technicalLeadId: technicalLead.id, parentCIId: server.id,
      software: { create: { version: '1.24.0', licenseType: 'Open Source (BSD)' } },
    },
  });
  console.log(`✅ CI: ${nginxSoftware.name}`);

  const stagingServer = await prisma.cI.create({
    data: {
      name: 'STG-SRV-01 Staging Server', apiSlug: 'stg-srv-01',
      criticality: Criticality.MEDIUM, environment: Environment.STAGING,
      technicalLeadId: technicalLead.id, locationId: mainDC.id,
      hardware: { create: { serialNumber: 'DELL-SN-STG-0099', model: 'PowerEdge R540', manufacturer: 'Dell' } },
    },
  });
  console.log(`✅ CI: ${stagingServer.name}`);

  await prisma.cI.create({
    data: {
      name: 'DEV-APP-01 Development App', apiSlug: 'dev-app-01',
      criticality: Criticality.LOW, environment: Environment.DEVELOPMENT,
      software: { create: { version: '3.2.1-dev', licenseType: 'Internal' } },
    },
  });
  console.log('✅ CI: DEV-APP-01');

  // ─── Contract ─────────────────────────────────────────────────────────────────

  const contract = await prisma.contract.create({
    data: {
      contractNumber: 'CONT-DELL-2024-001',
      startDate:      new Date('2024-01-01'),
      endDate:        new Date('2026-12-31'),
      vendorId:       dell.id,
      cis: { connect: [{ id: server.id }, { id: dbServer.id }, { id: stagingServer.id }] },
    },
  });
  console.log(`✅ Contract: ${contract.contractNumber}`);

  console.log('\n🎉 Seed complete!');
  console.log('─'.repeat(50));
  console.log('  🔑 Login credentials:');
  console.log('     admin@cmdb.local   / admin123  [ADMIN]');
  console.log('     auditor@cmdb.local / audit123  [VIEWER]');
  console.log('─'.repeat(50));
}

main()
  .catch((e) => { console.error('❌ Seed error:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
