import { Activity, CandlestickChart, FlaskConical, Newspaper, Scale, Send, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { signIn } from './auth';

// ---- the picture: how a trade gets decided ---------------------------------------------------
// One input, four analysts in parallel, one coordinator, then risk and execution in series.
interface Node { id: string; label: string; icon: LucideIcon; x: number; y: number; w: number }
const H = 44;
const NODES: Node[] = [
  { id: 'market', label: 'Mercado', icon: Activity, x: 0, y: 158, w: 128 },
  { id: 'technical', label: 'Técnico', icon: CandlestickChart, x: 196, y: 26, w: 146 },
  { id: 'news', label: 'Notícias', icon: Newspaper, x: 196, y: 114, w: 146 },
  { id: 'event', label: 'Eventos', icon: Zap, x: 196, y: 202, w: 146 },
  { id: 'strategist', label: 'Estratega', icon: FlaskConical, x: 196, y: 290, w: 146 },
  { id: 'coordinator', label: 'Coordenador', icon: Scale, x: 410, y: 158, w: 162 },
  { id: 'risk', label: 'Risco', icon: ShieldCheck, x: 640, y: 92, w: 120 },
  { id: 'execution', label: 'Execução', icon: Send, x: 640, y: 224, w: 120 },
];
const at = (id: string) => NODES.find((n) => n.id === id)!;
const LANES = ['technical', 'news', 'event', 'strategist'];

/** A horizontal S-curve from the right edge of one node to the left edge of another. */
function curve(from: string, to: string): string {
  const a = at(from);
  const b = at(to);
  const x1 = a.x + a.w;
  const y1 = a.y + H / 2;
  const x2 = b.x;
  const y2 = b.y + H / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}
const EDGES: Array<{ d: string; stage: number }> = [
  ...LANES.map((id) => ({ d: curve('market', id), stage: 0 })),
  ...LANES.map((id) => ({ d: curve(id, 'coordinator'), stage: 1 })),
  { d: curve('coordinator', 'risk'), stage: 2 },
  { d: `M${at('risk').x + 60},${at('risk').y + H} L${at('execution').x + 60},${at('execution').y}`, stage: 3 },
];

function Pipeline() {
  return (
    <svg className="pipe" viewBox="-8 12 776 336" role="img"
      aria-label="O mercado alimenta quatro analistas em paralelo; o coordenador junta os votos, o gestor de risco aprova e a execução envia a ordem.">
      {EDGES.map((e) => <path key={e.d} d={e.d} className="pipe-line" />)}
      {EDGES.map((e) => (
        <circle key={e.d} r="3.5" className="pipe-pulse" style={{ offsetPath: `path('${e.d}')`, animationDelay: `${e.stage * 0.7}s` }} />
      ))}
      {NODES.map((n) => (
        <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
          <rect width={n.w} height={H} rx="6" className={n.id === 'coordinator' ? 'pipe-node pipe-node-core' : 'pipe-node'} />
          <n.icon x={13} y={14} width={16} height={16} strokeWidth={1.75} className="pipe-icon" aria-hidden />
          <text x={38} y={27} className="pipe-label">{n.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ---- the form -----------------------------------------------------------------------------------
const FAILURES = {
  // One message for every credential failure: never reveal whether the email exists.
  wrong: 'Email ou palavra-passe incorretos.',
  throttled: 'Demasiadas tentativas. Espere um minuto e tente de novo.',
  unreachable: 'Não foi possível contactar o servidor.',
};

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => { emailRef.current?.focus(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Checked on submit, never while typing; the first field that fails takes the focus.
    const next: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) next.email = 'Escreva o email da conta, com @.';
    if (!password) next.password = 'Escreva a palavra-passe.';
    setErrors(next);
    setFailed(false);
    if (next.email) { setStatus(''); emailRef.current?.focus(); return; }
    if (next.password) { setStatus(''); passwordRef.current?.focus(); return; }

    setBusy(true);
    const slow = window.setTimeout(() => setStatus('A verificar…'), 300);
    const result = await signIn(email.trim(), password);
    window.clearTimeout(slow);
    setBusy(false);
    if (result === 'ok') return;
    setFailed(true);
    setStatus(FAILURES[result]);
    passwordRef.current?.focus();
    passwordRef.current?.select();
  }

  return (
    <main className="login">
      <section className="login-story" data-enter>
        <p className="wordmark">MT-AI</p>
        <div className="login-words">
          <h1>
            <span className="mask"><span>Oito agentes.</span></span>
            <span className="mask"><span>Uma decisão de cada vez.</span></span>
          </h1>
          <p className="login-lead">Analisam forex e metais no MetaTrader 5, votam entre si e só abrem posição quando o gestor de risco aprova.</p>
        </div>
        <div className="login-panel"><Pipeline /></div>
      </section>

      <section className="login-side">
        <form onSubmit={submit} noValidate>
          <h2>Entrar na mesa</h2>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email" ref={emailRef} type="email" name="email" autoComplete="username" inputMode="email"
              value={email} onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(errors.email)} aria-describedby="login-email-error"
            />
            <p className="field-error" id="login-email-error">{errors.email}</p>
          </div>
          <div className="field">
            <label htmlFor="login-password">Palavra-passe</label>
            <div className="field-row">
              <input
                id="login-password" ref={passwordRef} type={show ? 'text' : 'password'} name="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(errors.password)} aria-describedby="login-password-error"
              />
              <button type="button" className="field-toggle" aria-pressed={show} onClick={() => setShow((v) => !v)}>
                {show ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            <p className="field-error" id="login-password-error">{errors.password}</p>
          </div>
          <button type="submit" className="login-submit" aria-busy={busy}>Entrar na mesa</button>
          <p className={failed ? 'form-status is-failed' : 'form-status'} role="status">{status}</p>
          <p className="login-foot">Não há registo público. As contas são criadas por quem gere o servidor.</p>
        </form>
      </section>
    </main>
  );
}
