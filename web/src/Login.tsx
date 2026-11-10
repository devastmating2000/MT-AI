import { useState, type FormEvent } from 'react';
import { signIn } from './auth';

const MESSAGES = {
  // One message for every credential failure: never reveal whether the email exists.
  wrong: 'Email ou palavra-passe incorretos.',
  throttled: 'Demasiadas tentativas. Espere um minuto e tente de novo.',
  unreachable: 'Não foi possível contactar o servidor.',
};

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await signIn(email.trim(), password);
    setBusy(false);
    if (result === 'ok') return;
    setError(MESSAGES[result]);
    setPassword('');
  }

  return (
    <main className="login">
      <form onSubmit={submit} noValidate>
        <p className="wordmark">MT-AI</p>
        <h1>Entrar na mesa</h1>
        <p className="login-note">Acesso restrito aos operadores da conta.</p>
        <label>
          <span>Email</span>
          <input type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          <span>Palavra-passe</span>
          <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="login-error" role="alert">{error}</p>
        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? 'A verificar…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
