import { parseLoginIdentifier } from '../ldapIdentity';

describe('parseLoginIdentifier', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.LDAP_UPN_SUFFIX = 'azkar.com';
    process.env.LDAP_NETBIOS_DOMAIN = 'AZKARAD';
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('recognizes local cmdb.local accounts', () => {
    expect(parseLoginIdentifier('claude@cmdb.local')).toEqual({
      form: 'local',
      value: 'claude@cmdb.local',
    });
  });

  it('recognizes local cmdb.internal accounts', () => {
    expect(parseLoginIdentifier('admin@cmdb.internal')).toEqual({
      form: 'local',
      value: 'admin@cmdb.internal',
    });
  });

  it('recognizes NetBIOS DOMAIN\\sam form', () => {
    expect(parseLoginIdentifier('AZKARAD\\andres.matias')).toEqual({
      form: 'sam',
      value: 'andres.matias',
      ldapAttr: 'sAMAccountName',
    });
  });

  it('recognizes NetBIOS form even with an unexpected domain prefix', () => {
    expect(parseLoginIdentifier('OTHERDOMAIN\\andres.matias')).toEqual({
      form: 'sam',
      value: 'andres.matias',
      ldapAttr: 'sAMAccountName',
    });
  });

  it('recognizes the configured UPN suffix', () => {
    expect(parseLoginIdentifier('andres.matias@azkar.com')).toEqual({
      form: 'upn',
      value: 'andres.matias@azkar.com',
      ldapAttr: 'userPrincipalName',
    });
  });

  it('falls back to mail form for other email domains (retrocompat)', () => {
    expect(parseLoginIdentifier('andres.matias@dachser.com')).toEqual({
      form: 'mail',
      value: 'andres.matias@dachser.com',
      ldapAttr: 'mail',
    });
  });

  it('recognizes a bare sAMAccountName', () => {
    expect(parseLoginIdentifier('andres.matias')).toEqual({
      form: 'sam',
      value: 'andres.matias',
      ldapAttr: 'sAMAccountName',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseLoginIdentifier('  andres.matias  ')).toEqual({
      form: 'sam',
      value: 'andres.matias',
      ldapAttr: 'sAMAccountName',
    });
  });

  it('treats email-like input as mail when LDAP_UPN_SUFFIX is unset', () => {
    delete process.env.LDAP_UPN_SUFFIX;
    expect(parseLoginIdentifier('andres.matias@azkar.com')).toEqual({
      form: 'mail',
      value: 'andres.matias@azkar.com',
      ldapAttr: 'mail',
    });
  });
});
