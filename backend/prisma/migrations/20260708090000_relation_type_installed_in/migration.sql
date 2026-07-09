-- v3.4.4: INSTALLED_IN relation type (blade/module → enclosure/converged)
ALTER TYPE "RelationType" ADD VALUE IF NOT EXISTS 'INSTALLED_IN';
