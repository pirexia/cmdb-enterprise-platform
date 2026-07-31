import { Request, Response, NextFunction } from 'express';
import { requireSecurityRead, requireSecurityWrite } from '../requireSecurity.js';

// New SOC role (v3.6.0 follow-up): full operational access to the Security
// area (Greenbone/CrowdStrike upload + vuln-import staging review), same
// authority ADMIN already had there — but SOC must not gain access anywhere
// else in the app. These two middlewares are the sole gate for that area.

function mockReq(role?: string): Partial<Request> {
  return role ? { user: { id: 'u1', username: 'u', email: 'u@cmdb.local', role: role as never } } : {};
}

function mockRes(): { res: Partial<Response>; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { res: { status: status as unknown as Response['status'] }, status, json };
}

describe('requireSecurityRead', () => {
  it.each(['ADMIN', 'AUDITOR', 'SOC'])('allows %s', (role) => {
    const next = jest.fn();
    requireSecurityRead(mockReq(role) as Request, mockRes().res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['VIEWER', 'MANAGER'])('rejects %s with 403', (role) => {
    const next = jest.fn();
    const { res, status } = mockRes();
    requireSecurityRead(mockReq(role) as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it('rejects an unauthenticated request with 403', () => {
    const next = jest.fn();
    const { res, status } = mockRes();
    requireSecurityRead(mockReq(undefined) as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});

describe('requireSecurityWrite', () => {
  it.each(['ADMIN', 'SOC'])('allows %s', (role) => {
    const next = jest.fn();
    requireSecurityWrite(mockReq(role) as Request, mockRes().res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['VIEWER', 'MANAGER', 'AUDITOR'])('rejects %s with 403 — read access does not imply write', (role) => {
    const next = jest.fn();
    const { res, status } = mockRes();
    requireSecurityWrite(mockReq(role) as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
