export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER' | 'MANAGER';

export interface JwtPayload {
  id:               string;
  username:         string;
  email:            string;
  role:             UserRole;
  mfaSetupRequired?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
