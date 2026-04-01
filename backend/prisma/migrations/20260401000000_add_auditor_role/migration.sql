-- Add AUDITOR value to UserRole enum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'AUDITOR';
