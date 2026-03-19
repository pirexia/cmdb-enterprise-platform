-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('HOSTS', 'DEPENDS_ON', 'CONNECTED_TO', 'PROVIDES_SERVICE', 'BACKED_UP_BY');

-- CreateTable
CREATE TABLE "ci_relations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_ci_id" UUID NOT NULL,
    "target_ci_id" UUID NOT NULL,
    "relation_type" "RelationType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "ci_relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ci_relations_source_ci_id_target_ci_id_relation_type_key" ON "ci_relations"("source_ci_id", "target_ci_id", "relation_type");

-- AddForeignKey
ALTER TABLE "ci_relations" ADD CONSTRAINT "ci_relations_source_ci_id_fkey" FOREIGN KEY ("source_ci_id") REFERENCES "configuration_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_relations" ADD CONSTRAINT "ci_relations_target_ci_id_fkey" FOREIGN KEY ("target_ci_id") REFERENCES "configuration_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
