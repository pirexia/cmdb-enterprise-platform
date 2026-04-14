-- Add indexes on foreign key columns for query performance (issue #19)

-- Document
CREATE INDEX IF NOT EXISTS "documents_document_type_id_idx" ON "documents"("document_type_id");
CREATE INDEX IF NOT EXISTS "documents_root_id_idx" ON "documents"("root_id");

-- CI
CREATE INDEX IF NOT EXISTS "configuration_items_ci_type_id_idx" ON "configuration_items"("ci_type_id");
CREATE INDEX IF NOT EXISTS "configuration_items_business_owner_id_idx" ON "configuration_items"("business_owner_id");
CREATE INDEX IF NOT EXISTS "configuration_items_technical_lead_id_idx" ON "configuration_items"("technical_lead_id");
CREATE INDEX IF NOT EXISTS "configuration_items_branch_id_idx" ON "configuration_items"("branch_id");
CREATE INDEX IF NOT EXISTS "configuration_items_ci_model_id_idx" ON "configuration_items"("ci_model_id");
CREATE INDEX IF NOT EXISTS "configuration_items_parent_ci_id_idx" ON "configuration_items"("parent_ci_id");

-- Contract
CREATE INDEX IF NOT EXISTS "contracts_vendor_id_idx" ON "contracts"("vendor_id");
CREATE INDEX IF NOT EXISTS "contracts_parent_contract_id_idx" ON "contracts"("parent_contract_id");

-- License
CREATE INDEX IF NOT EXISTS "licenses_vendor_id_idx" ON "licenses"("vendor_id");
CREATE INDEX IF NOT EXISTS "licenses_license_type_id_idx" ON "licenses"("license_type_id");
CREATE INDEX IF NOT EXISTS "licenses_license_metric_id_idx" ON "licenses"("license_metric_id");
CREATE INDEX IF NOT EXISTS "licenses_parent_license_id_idx" ON "licenses"("parent_license_id");

-- CIRelation reverse lookup
CREATE INDEX IF NOT EXISTS "ci_relations_target_ci_id_idx" ON "ci_relations"("target_ci_id");
