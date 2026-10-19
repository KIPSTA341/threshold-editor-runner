document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = document.getElementById('err'), b = f.querySelector('button');
  err.textContent = ''; b.disabled = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'editor' },
      body: JSON.stringify({ email: f.email.value, password: f.password.value }) });
    if (r.ok) { location.href = '/'; return; }
    err.textContent = (await r.json().catch(() => ({}))).error || 'Sign-in failed.';
  } catch { err.textContent = 'Cannot reach the editor. Check your connection.'; }
  b.disabled = false;
});
