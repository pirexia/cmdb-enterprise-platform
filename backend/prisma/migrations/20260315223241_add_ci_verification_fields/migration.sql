/*
  Warnings:

  - A unique constraint covering the columns `[inventory_number]` on the table `configuration_items` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "configuration_items" ADD COLUMN     "assigned_user" TEXT,
ADD COLUMN     "branch_id" UUID,
ADD COLUMN     "ci_model_id" UUID,
ADD COLUMN     "console_ip" TEXT,
ADD COLUMN     "floor" TEXT,
ADD COLUMN     "inventory_number" TEXT,
ADD COLUMN     "rack" TEXT,
ADD COLUMN     "rack_unit" TEXT,
ADD COLUMN     "room" TEXT,
ADD COLUMN     "status" TEXT DEFAULT 'ACTIVO',
ADD COLUMN     "user_dni" TEXT,
ADD COLUMN     "vlan" TEXT;

-- CreateTable
CREATE TABLE "support_areas" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "branch_code" TEXT NOT NULL,
    "physical_address" TEXT,
    "support_area_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_models" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_areas_name_key" ON "support_areas"("name");

-- CreateIndex
CREATE UNIQUE INDEX "branches_branch_code_key" ON "branches"("branch_code");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturers_name_key" ON "manufacturers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "providers_name_key" ON "providers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "configuration_items_inventory_number_key" ON "configuration_items"("inventory_number");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_support_area_id_fkey" FOREIGN KEY ("support_area_id") REFERENCES "support_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_models" ADD CONSTRAINT "device_models_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_items" ADD CONSTRAINT "configuration_items_ci_model_id_fkey" FOREIGN KEY ("ci_model_id") REFERENCES "device_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
