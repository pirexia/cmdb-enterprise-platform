/**
 * Etiqueta a mostrar para un usuario (v3.5.10).
 *
 * El directorio devuelve el nombre real ("Andrés Matías López"); el username es
 * el sAMAccountName ("andres.matias"). Se prefiere el primero y se cae al
 * segundo para cuentas locales y para filas anteriores a v3.5.10, que aún no
 * tienen display_name poblado.
 *
 * Solo para PRESENTACIÓN: no usar como clave de React ni para comparar
 * identidades — el displayName no es único ni estable.
 */
export function displayLabel(u: { displayName?: string | null; username: string }): string {
  const dn = u.displayName?.trim();
  return dn ? dn : u.username;
}
