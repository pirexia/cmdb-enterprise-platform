import { Request, Response, NextFunction } from 'express';
import { requireDcimAccess } from '../middleware.js';

// v3.6.0 (follow-up): the new SOC role is scoped to the Security area only
// (see shared/middleware/requireSecurity.ts) and must NOT gain DCIM access
// via this denylist-style gate (which historically only blocked VIEWER).

function mockReq(role?: string): Partial<Request> {
  return role ? { user: { role } } as unknown as Partial<Request> : {};
}

function mockRes(): { res: Partial<Response>; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { res: { status: status as unknown as Response['status'] }, status };
}

describe('requireDcimAccess', () => {
  it.each(['ADMIN', 'AUDITOR', 'MANAGER'])('allows %s', (role) => {
    const next = jest.fn();
    requireDcimAccess(mockReq(role) as Request, mockRes().res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['VIEWER', 'SOC'])('rejects %s with 403', (role) => {
    const next = jest.fn();
    const { res, status } = mockRes();
    requireDcimAccess(mockReq(role) as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
