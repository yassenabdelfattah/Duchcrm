import { adminClient, json } from './db.ts';

/**
 * Who may call this function. Returns a response to send back when the
 * caller is refused, or null when they may proceed.
 *
 * The gateway's verify_jwt only proves a token is genuine - and the anon key
 * is a genuine token. It ships inside the dashboard's JavaScript, so without
 * this check anyone who opened the site could start an import or a stock push
 * with the service role's full access. The rule from DECISIONS.md #5 applies
 * here too: the server decides, not which buttons were rendered.
 *
 * Two callers are accepted: the service role (the Worker, or a person running
 * a command with the service key), and an active staff member whose role
 * carries `permission` - or any active staff member with a role, when
 * `permission` is null. Roles are read from public.roles, the same as the
 * database's own checks, so a custom role works here too. Only use this on
 * functions deployed with verify_jwt on - the service role claim is trusted
 * because the gateway already checked the signature.
 */
export async function authorize(req: Request, permission: string | null): Promise<Response | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (roleClaim(token) === 'service_role') return null;

  const db = adminClient();
  const { data: auth, error } = await db.auth.getUser(token);
  if (error || !auth.user) {
    return json({ error: 'not_signed_in' }, 401);
  }

  const { data: staff } = await db
    .from('staff')
    .select('is_active, roles!staff_role_id_fkey ( permissions )')
    .eq('id', auth.user.id)
    .maybeSingle();

  const permissions = (staff?.roles as { permissions?: string[] } | null)?.permissions ?? null;
  const allowed =
    Boolean(staff?.is_active) &&
    permissions !== null &&
    (permission === null || permissions.includes('*') || permissions.includes(permission));

  if (!allowed) {
    return json({ error: 'not_allowed' }, 403);
  }

  return null;
}

function roleClaim(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
}
