-- CreateEnum
CREATE TYPE "Criticality" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL');

-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('SITE', 'DATACENTER', 'RACK');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "sso_external_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "parent_location_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "contract_number" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "vendor_id" UUID NOT NULL,
    "parent_contract_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuration_items" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "api_slug" TEXT NOT NULL,
    "criticality" "Criticality" NOT NULL,
    "environment" "Environment" NOT NULL,
    "eol_date" TIMESTAMP(3),
    "eos_date" TIMESTAMP(3),
    "business_owner_id" UUID,
    "technical_lead_id" UUID,
    "location_id" UUID,
    "cost_center_id" UUID,
    "parent_ci_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuration_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hardware_cis" (
    "ci_id" UUID NOT NULL,
    "serial_number" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,

    CONSTRAINT "hardware_cis_pkey" PRIMARY KEY ("ci_id")
);

-- CreateTable
CREATE TABLE "software_cis" (
    "ci_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "license_type" TEXT NOT NULL,

    CONSTRAINT "software_cis_pkey" PRIMARY KEY ("ci_id")
);

-- CreateTable
CREATE TABLE "_ContractToCI" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_sso_external_id_key" ON "users"("sso_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_code_key" ON "cost_centers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_contract_number_key" ON "contracts"("contract_number");

-- CreateIndex
CREATE UNIQUE INDEX "configuration_items_api_slug_key" ON "configuration_items"("api_slug");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_cis_serial_number_key" ON "hardware_cis"("serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "_ContractToCI_AB_unique" ON "_ContractToCI"("A", "B");

-- CreateIndex
CREATE INDEX "_ContractToCI_B_index" ON "_ContractToCI"("B");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_location_id_fkey" FOREIGN KEY ("parent_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_parent_contract_id_fkey" FOREIGN KEY ("parent_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_business_owner_id_fkey" FOREIGN KEY ("business_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_technical_lead_id_fkey" FOREIGN KEY ("technical_lead_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "cost_centers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_parent_ci_id_fkey" FOREIGN KEY ("parent_ci_id") REFERENCES "configuration_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hardware_cis" ADD CONSTRAINT "hardware_cis_ci_id_fkey" FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "software_cis" ADD CONSTRAINT "software_cis_ci_id_fkey" FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContractToCI" ADD CONSTRAINT "_ContractToCI_A_fkey" FOREIGN KEY ("A") REFERENCES "configuration_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContractToCI" ADD CONSTRAINT "_ContractToCI_B_fkey" FOREIGN KEY ("B") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
