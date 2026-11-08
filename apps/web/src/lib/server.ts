/** Server-side fetch for public pages (no auth). Uses the internal API URL inside Docker. */
export async function serverGet<T>(path: string, revalidate = 30): Promise<T | null> {
  try {
    const base = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const res = await fetch(`${base}${path}`, { next: { revalidate } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
