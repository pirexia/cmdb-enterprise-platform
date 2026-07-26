import { computeLdapSyncDiff, type ExistingUserRow } from '../ldapSyncService';
import type { AdGroupMember } from '../../../services/ldapDirectory';

const ACCOUNT_DISABLE = 0x2;

const existing: ExistingUserRow[] = [
  { id: '1', ssoExternalId: 'ana.perez',  email: 'ana@corp.local',  username: 'ana.perez',  displayName: 'Ana Pérez',  active: true,  role: 'VIEWER' },
  { id: '2', ssoExternalId: 'luis.gomez', email: 'luis@corp.local', username: 'luis.gomez', displayName: 'Luis Gómez', active: false, role: 'MANAGER' },
  { id: '3', ssoExternalId: 'old.user',   email: 'old@corp.local',  username: 'old.user',   displayName: 'Old User',   active: true,  role: 'VIEWER' },
];

const m = (o: Partial<AdGroupMember> & { sAMAccountName: string }): AdGroupMember => o as AdGroupMember;

describe('computeLdapSyncDiff — altas', () => {
  it('crea los miembros del grupo que no existen en la BD', () => {
    const d = computeLdapSyncDiff([m({ sAMAccountName: 'nuevo', mail: 'n@corp.local', displayName: 'Nuevo' })], []);
    expect(d.creates).toHaveLength(1);
    expect(d.creates[0]).toMatchObject({ ssoExternalId: 'nuevo', email: 'n@corp.local', username: 'nuevo', displayName: 'Nuevo' });
  });

  it('normaliza el sAMAccountName a minúsculas para casar con la fila existente', () => {
    const d = computeLdapSyncDiff([m({ sAMAccountName: 'Ana.Perez', mail: 'ana@corp.local', displayName: 'Ana Pérez' })], existing);
    expect(d.creates).toHaveLength(0);
  });

  it('no crea una cuenta que ya viene deshabilitada en AD', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'nuevo', mail: 'n@corp.local', userAccountControl: ACCOUNT_DISABLE })],
      [],
    );
    expect(d.creates).toHaveLength(0);
  });
});

describe('computeLdapSyncDiff — actualizaciones', () => {
  it('actualiza email, username y displayName cuando difieren', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'ana.perez', mail: 'ana.perez@corp.local', displayName: 'Ana Pérez Ruiz' })],
      existing,
    );
    expect(d.updates).toEqual([
      { id: '1', email: 'ana.perez@corp.local', username: 'ana.perez', displayName: 'Ana Pérez Ruiz' },
    ]);
  });

  it('no propone actualización cuando nada ha cambiado', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'ana.perez', mail: 'ana@corp.local', displayName: 'Ana Pérez' }),
       m({ sAMAccountName: 'old.user',  mail: 'old@corp.local', displayName: 'Old User' })],
      existing,
    );
    expect(d.updates).toHaveLength(0);
    expect(d.creates).toHaveLength(0);
    expect(d.deactivates).toHaveLength(0);
  });

  // D9 — AD posee la identidad, el operador la gobernanza. Una promoción manual
  // a MANAGER/ADMIN no puede perderse en la pasada nocturna.
  it('nunca propone cambiar el rol', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'luis.gomez', mail: 'luis@corp.local', displayName: 'Luis Gómez' })],
      existing,
    );
    expect(JSON.stringify(d)).not.toContain('role');
    expect(d.updates.every((u) => !('role' in u))).toBe(true);
  });
});

describe('computeLdapSyncDiff — reactivaciones y bajas', () => {
  it('reactiva a quien estaba inactivo y vuelve a estar en el grupo', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'luis.gomez', mail: 'luis@corp.local', displayName: 'Luis Gómez' })],
      existing,
    );
    expect(d.reactivates).toEqual(['2']);
  });

  it('desactiva a quien ya no está en el grupo, sin borrarlo', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'ana.perez', mail: 'ana@corp.local', displayName: 'Ana Pérez' })],
      existing,
    );
    expect(d.deactivates).toContain('3');
    expect(d).not.toHaveProperty('deletes');
  });

  it('desactiva a quien tiene la cuenta deshabilitada en AD aunque siga en el grupo', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'ana.perez', mail: 'ana@corp.local', displayName: 'Ana Pérez', userAccountControl: ACCOUNT_DISABLE })],
      existing,
    );
    expect(d.deactivates).toContain('1');
  });

  it('no vuelve a desactivar a quien ya está inactivo', () => {
    const d = computeLdapSyncDiff([], existing);
    // '2' ya está inactivo: solo '1' y '3' deben desactivarse.
    expect(d.deactivates.sort()).toEqual(['1', '3']);
  });

  it('una cuenta deshabilitada en AD que ya está inactiva no genera trabajo', () => {
    const d = computeLdapSyncDiff(
      [m({ sAMAccountName: 'luis.gomez', mail: 'luis@corp.local', userAccountControl: ACCOUNT_DISABLE })],
      existing,
    );
    expect(d.deactivates).not.toContain('2');
    expect(d.reactivates).not.toContain('2');
  });
});

describe('computeLdapSyncDiff — invariantes de seguridad', () => {
  it('un grupo vacío desactiva a todos los LDAP activos pero no borra ninguno', () => {
    const d = computeLdapSyncDiff([], existing);
    expect(d.creates).toHaveLength(0);
    expect(d.updates).toHaveLength(0);
    expect(Object.keys(d)).toEqual(['creates', 'updates', 'reactivates', 'deactivates']);
  });

  it('un miembro sin sAMAccountName utilizable no rompe el diff', () => {
    const d = computeLdapSyncDiff([m({ sAMAccountName: 'ana.perez' })], existing);
    // Sin mail, se sintetiza uno; lo relevante es que no lanza.
    expect(d.creates).toHaveLength(0);
  });
});
