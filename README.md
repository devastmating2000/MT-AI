# MT-AI

Mesa de negociação com vários agentes de IA para forex e metais (ouro, prata), ligada ao MetaTrader 5.
Funciona com qualquer corretor MT5, incluindo a VT Markets. Servidor em TypeScript (Node), painel em React.

Oito agentes trocam mensagens entre si através de um barramento: um recebe o mercado, um corre as
estratégias, um lê as notícias, um negoceia a reação a dados como o IPC, um testa as estratégias e dá-lhes peso, um coordena a decisão, um gere o
risco e um executa. O painel mostra a conversa em direto.

> **Aviso.** Negociar com alavancagem pode perder todo o capital. Nenhuma estratégia tem taxa de acerto
> garantida e resultados de backtest não se repetem obrigatoriamente no mercado real. Use primeiro o
> simulador e depois uma conta **demo**. Isto é software, não é aconselhamento financeiro.

## Arranque rápido (simulador)

```bash
npm install
npm run dev        # servidor em :8787, painel em http://localhost:5173
```

Por omissão corre em modo `paper`: um corretor simulado com preços **sintéticos** (uma vela M15 a cada
2 segundos), para ver os agentes a trabalhar sem conta nem risco. O calendário e o sentimento de notícias
também são simulados neste modo e estão assinalados como tal.

Outros comandos:

| Comando | O que faz |
|---|---|
| `npm test` | 30 testes: indicadores, backtester, pesos, corretor simulado, protocolo MT5, mesa completa |
| `npm run simulate -- XAUUSD 90` | Corre a mesa completa (todos os agentes) 90 dias no simulador e imprime o resumo |
| `NODE_USE_ENV_PROXY=1 npm run live -- XAUUSD 30 60` | Mesa completa 30 min com **cotações reais** (Swissquote) e execução simulada, velas de 60 s. `--force` põe as estratégias do banco a votar |
| `npm run backtest -- 6000` | Backtest de todas as estratégias em dados sintéticos |
| `npm run build && npm start` | Compila o painel e serve tudo em `http://127.0.0.1:8787` |

## Preços reais sem conta (modo `live`)

`MTAI_MODE=live` usa a cotação pública de compra/venda da Swissquote, lida de 2 em 2 segundos, e simula
a execução dentro do processo: nenhuma ordem sai para um corretor. O histórico para aquecer os
indicadores vem do Yahoo; no ouro e na prata é o contrato de futuros deslocado para o preço à vista,
por isso as velas antigas são uma aproximação. `MTAI_TIMEFRAME_SEC` muda o período das velas
(por omissão 900). Atrás de um proxy, o Node precisa de `NODE_USE_ENV_PROXY=1`.

## Publicar: painel no Vercel, servidor noutro sítio, login no Neon

O Vercel só serve ficheiros estáticos e funções de curta duração. O servidor de agentes é um processo
que fica sempre ligado e usa WebSocket, por isso **não corre no Vercel**: publicar só o repositório lá
dá `404` em `/api` e falha em `wss://.../ws`. A divisão é:

| Peça | Onde corre |
|---|---|
| Painel (`web/`) | Vercel, com `vercel.json` já incluído |
| Servidor de agentes (`server/`) | Uma máquina sempre ligada: o PC ou VPS Windows onde está o MT5, ou um serviço como Railway, Fly.io ou Render |
| Contas, sessões e registo de auditoria | Neon (Postgres), plano gratuito |

Passos:

1. **Neon.** Crie um projeto e copie a ligação "pooled" para `DATABASE_URL` no servidor. As tabelas são
   criadas no arranque.
2. **Operador.** No servidor: `npm run user -- add o-seu@email.com` e escolha uma palavra-passe com 12
   ou mais caracteres. Não existe página de registo: só quem tem acesso ao servidor cria contas.
3. **Servidor.** Exponha-o por HTTPS (Caddy, nginx ou Cloudflare Tunnel) num endereço como
   `https://api.mtbot.dev` e defina `MTAI_ALLOWED_ORIGINS=https://mtbot.dev`, `MTAI_TRUST_PROXY=1`,
   `MTAI_HSTS=true`.
4. **Vercel.** Em Settings > Environment Variables defina `VITE_API_URL=https://api.mtbot.dev` e volte a
   publicar. O Vercel não precisa de `DATABASE_URL` nem de nenhum segredo.

### Segurança

- **Sem login não há acesso remoto.** O servidor recusa arrancar fora de `127.0.0.1` se `DATABASE_URL`
  não estiver definido.
- **Palavras-passe** guardadas com scrypt (32 MB por tentativa) e sal aleatório; nunca em claro.
- **Sessões** de 12 horas. O token tem 256 bits aleatórios e a base de dados guarda só o seu hash, por
  isso uma cópia roubada da base de dados não dá acesso. Mudar a palavra-passe termina todas as sessões.
- **Força bruta:** 10 tentativas de login por minuto por endereço e bloqueio da conta durante 15 minutos
  após 5 palavras-passe erradas. A resposta é igual para email desconhecido, palavra-passe errada e
  conta bloqueada.
- **API e WebSocket** exigem o token em todos os pedidos; o WebSocket não envia nada antes de o validar
  e fecha quando a sessão acaba. Só as origens em `MTAI_ALLOWED_ORIGINS` passam no CORS.
- **SQL** sempre parametrizado. Cabeçalhos CSP, `X-Frame-Options`, `nosniff` e HSTS no servidor e no Vercel.
- **Auditoria:** entradas, falhas, pausas, alterações de risco e fechos manuais ficam na tabela `audit_log`.
- A ponte do MT5 (`/bridge/sync`) tem o seu próprio segredo (`MTAI_BRIDGE_TOKEN`) e limite de pedidos.

Limites conhecidos: o token fica no `localStorage` do browser (a CSP só permite scripts do próprio
site, mas um script malicioso que lá chegasse poderia lê-lo); não há segundo fator de autenticação; o
limite de pedidos é por processo e não sobrevive a um reinício.

## Ligar ao MetaTrader 5 (VT Markets ou outro)

O MT5 não tem API de rede, por isso a ligação é feita por um Expert Advisor que fala com o servidor por
HTTP uma vez por segundo. Não depende de serviços de terceiros.

1. Copie `.env.example` para `.env` e defina:
   ```
   MTAI_MODE=mt5
   MTAI_BRIDGE_TOKEN=<segredo com 16 ou mais caracteres>
   MTAI_TRADING_ENABLED=false
   ```
   Arranque com `node --env-file=.env --import tsx server/index.ts` (ou exporte as variáveis e use `npm start`).
2. No MT5: **Ferramentas > Opções > Expert Advisors**, ative "Permitir WebRequest para os URL listados" e
   adicione `http://127.0.0.1:8787`.
3. Copie `mt5/MTAI_Bridge.mq5` para `MQL5/Experts`, compile no MetaEditor e arraste-o para um gráfico
   qualquer. Parâmetros:
   - `InpToken`: o mesmo valor de `MTAI_BRIDGE_TOKEN`.
   - `InpSuffix`: o sufixo dos símbolos na sua conta. Na VT Markets depende do tipo de conta
     (por exemplo `-STD` ou `-ECN`); veja o nome exato na Observação do Mercado.
   - `InpSymbols`: os símbolos sem sufixo, iguais a `MTAI_SYMBOLS`.
4. Ative o botão **Algo Trading**. O painel passa a mostrar "MetaTrader 5 ligado".

Com `MTAI_TRADING_ENABLED=false` os agentes analisam e decidem, mas não enviam ordens. Quando estiver
satisfeito com o que vê numa conta demo, use o botão "Retomar negociação" no painel ou mude a variável.

Sem `DATABASE_URL` o servidor escuta só em `127.0.0.1` e não tem login; para acesso remoto veja a secção sobre publicação.

## Os agentes

| Agente | Função |
|---|---|
| Dados de mercado | Guarda as velas e anuncia cada fecho |
| Analista técnico | Corre as cinco estratégias em cada vela fechada |
| Analista de notícias | Calendário económico e sentimento por moeda; bloqueia entradas perto de dados de alto impacto |
| Especialista em eventos | Negoceia a reação a dados de alto impacto (IPC, emprego, taxas de juro) depois de a vela da notícia fechar |
| Estratega | Faz backtest de cada estratégia em cada símbolo, atribui pesos e manda para o banco as que perdem |
| Coordenador | Soma os votos ponderados, consulta as notícias, pede revisão ao modelo de linguagem e propõe |
| Gestor de risco | Dimensiona pelo stop e pode vetar; os limites dele não são negociáveis |
| Execução | O único que fala com o corretor |

Fluxo de uma decisão: `técnico → coordenador → estratega (pesos) → notícias (bloqueio/sentimento) →
[modelo de linguagem] → risco (aprovação e lotes) → execução`. Tudo passa por `server/bus.ts`.

### Estratégias e "maior taxa de acerto"

`server/strategies/index.ts`: recuo na tendência (EMA 20/50/200), reversão à média (Bollinger + RSI),
rutura Donchian, momentum MACD e rutura da sessão de Londres.

O estratega mede cada uma no histórico do próprio símbolo (taxa de acerto, fator de lucro, expectativa em
R, queda máxima) e repete o teste a cada 96 velas. O peso de voto segue a taxa de acerto, mas só vota quem
tem **expectativa positiva**: uma estratégia que acerta 85% das vezes e perde dinheiro fica no banco. Os
resultados ao vivo entram na conta à medida que as operações fecham.

O backtester preenche na abertura da vela seguinte, desconta o spread e, quando uma vela toca no stop e no
alvo, assume que o stop foi primeiro.

### Dias de notícias (IPC, emprego, decisões de taxas)

Os dados dos EUA saem normalmente às 13:30 de Lisboa e movem o dólar, o ouro e a prata em segundos.
O especialista em eventos (`server/agents/event.ts`) trata desses momentos:

1. Uma hora antes, o analista de notícias avisa a mesa e o especialista publica o plano: que símbolos
   vigia e para que lado cada um costuma ir se o valor sair acima ou abaixo do previsto.
2. **Não tenta adivinhar o número.** Ninguém o conhece antes da hora e o calendário público não traz o
   valor real. Espera que a vela M15 da notícia feche.
3. Só conta como reação uma vela com pelo menos 1,8× a amplitude média e fecho decidido para um lado.
   Uma vela grande que fecha a meio (o "sobe e desce") é ignorada.
4. Exige que os vários símbolos contem a mesma história sobre a moeda (por exemplo dólar forte: EURUSD
   e ouro a cair, USDJPY a subir). Se discordam, fica de fora.
5. Propõe no máximo duas operações por evento, a favor do movimento, com stop a meio da vela da notícia
   e alvo a 1,5× o risco.

Estas operações não passam pelo bloqueio de notícias (a notícia é o motivo da operação), mas entram
sempre com **metade do tamanho** normal, porque o spread e o deslize são piores nessas alturas, e o
gestor de risco continua a poder vetar. Não existe histórico de calendário para fazer backtest, por
isso o registo é feito ao vivo: se um símbolo acumular seis ou mais operações com resultado negativo, o
especialista deixa de o negociar. No simulador os saltos de preço nas horas das notícias são inventados
para exercitar esta lógica; o resultado que lá obtém não prevê o resultado real.

A entrada é feita no fecho da vela de 15 minutos, por isso apanha a continuação do movimento e não o
primeiro salto.

### Risco

Valores por omissão (editáveis no painel, separador Risco): 0,5% do capital por operação, perda diária
máxima de 3%, 3 posições em simultâneo, 2 no mesmo sentido por moeda, 30 minutos de bloqueio à volta de
notícias de alto impacto. Toda a ordem leva stop e alvo.

### Modelo de linguagem (opcional)

Com `ANTHROPIC_API_KEY` definida, o analista de notícias classifica os títulos por moeda e o coordenador
pede uma segunda opinião antes de propor (aprovar, reduzir ou vetar). O modelo só pode **reduzir ou
bloquear** uma operação, nunca aumentá-la, e o gestor de risco decide sempre depois dele. Sem chave, ou se
a API falhar, os agentes usam regras determinísticas. O modelo é `claude-opus-5-5` por omissão
(`MTAI_LLM_MODEL`), com fallback do lado do servidor ativado para recusas; cada proposta de operação é uma
chamada, por isso tem custo.

## Protocolo da ponte

`POST /bridge/sync`, cabeçalho `X-MTAI-Token`, texto simples, um registo por linha, campos separados por `|`.

| EA → servidor | Servidor → EA |
|---|---|
| `ACCOUNT\|saldo\|capital\|moeda` | `HISTORY\|símbolo\|velas` |
| `SPEC\|símbolo\|dígitos\|ponto\|contrato\|loteMin\|passo\|tickValue\|tickSize` | `OPEN\|id\|símbolo\|BUY/SELL\|lotes\|stop\|alvo\|comentário` |
| `TICK\|símbolo\|bid\|ask\|hora` | `CLOSE\|id\|posição` |
| `HIST` / `BAR\|símbolo\|hora\|o\|h\|l\|c\|v` | |
| `POSITIONS\|n` e `POS\|id\|símbolo\|BUY/SELL\|lotes\|entrada\|stop\|alvo\|lucro\|hora` | |
| `RESULT\|id\|OK/ERR\|posição\|preço\|mensagem` | |
| `DEAL\|posição\|símbolo\|lucro\|preço\|hora\|SL/TP/MANUAL/OTHER` | |

As horas vão em UTC (o EA desconta o fuso do servidor do corretor).

## Estrutura

```
shared/types.ts        tipos partilhados entre servidor e painel
server/bus.ts          barramento de mensagens entre agentes
server/agents/         os oito agentes
server/strategies/     indicadores e estratégias
server/backtest/       motor de backtest e pesos
server/broker/         corretor simulado e ponte MT5
server/llm/            cliente do modelo de linguagem
mt5/MTAI_Bridge.mq5    Expert Advisor
web/src/               painel React
tests/                 testes (vitest)
```

## Design do painel

O painel seguiu as regras de três skills públicas de design: [taste-skill](https://github.com/Leonxlnx/taste-skill),
[Hallmark](https://github.com/Nutlope/hallmark) (anti-slop) e
[UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill). Na prática: todas as cores e
fontes são tokens em `:root`, temas claro e escuro, sem gradientes, sem cartões dentro de cartões, sem
emojis, sem etiquetas em maiúsculas espaçadas, foco de teclado visível, respeito por
`prefers-reduced-motion`, algarismos tabulares e layout que funciona a 390 px.

## Limitações conhecidas

- O Expert Advisor foi escrito para a API MQL5 mas **não foi compilado nem testado num terminal real**
  neste repositório; o lado do servidor do protocolo está coberto por testes.
- O calendário económico (Forex Factory) e os feeds RSS só são usados em modo `mt5` e dependem de
  serviços externos; se falharem, o painel avisa e deixa de haver bloqueio por notícias.
- Os preços do simulador são um processo aleatório com regimes de tendência e de lateralização. Servem
  para exercitar o sistema, não dizem nada sobre o desempenho em mercados reais.
- Um fecho parcial feito à mão no MT5 é tratado como fecho total.
