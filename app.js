/* ── Covenant · leveragecoin mockup ──────────────────────────── */

/* Real on-chain / oracle values ------------------------------- */
const SHMON_APR = 12.78;          // DefiLlama pool ee40513c, 30d base APY
const SHMON_TO_MON = 1.5444228986733135;  // convertToAssets(1e18) on 0x1B68...De19c
const MON_DEBT_BORROW = 3.50;     // paid to MON.b.shMON holders
const USD_DEBT_BORROW = 8.20;     // paid to USD.b.shMON holders

/* Market definitions ------------------------------------------ */
const markets = [
  {
    id: 'shMONx2.usd',
    ticker: 'shMONx2',
    quote: 'usd',
    debt: 'usd',
    leverage: 2,
    kind: 'perp',
    description:
      'Behaves like a 2× MON/USD perpetual. Long 2 MON of shMON exposure against 1 MON of USD debt, with the shMON base yield earned on the full long leg.',
    tvl: 9824000,
    holders: 3820,
    liqDropPct: 44,
    spark: [12, 14, 13, 16, 20, 18, 22, 25, 23, 27, 30, 28, 32],
  },
  {
    id: 'shMONx3.usd',
    ticker: 'shMONx3',
    quote: 'usd',
    debt: 'usd',
    leverage: 3,
    kind: 'perp',
    description:
      'A 3× long MON/USD position with an ERC-20 wrapper. Amplifies both shMON yield and MON price action by 3×, funded by USD debt.',
    tvl: 6118000,
    holders: 2014,
    liqDropPct: 30,
    spark: [10, 11, 10, 13, 15, 14, 17, 22, 19, 24, 28, 26, 31],
  },
  {
    id: 'shMONx5.usd',
    ticker: 'shMONx5',
    quote: 'usd',
    debt: 'usd',
    leverage: 5,
    kind: 'perp',
    description:
      'Maximum USD-debt leverage on MON. Equivalent exposure to a 5× MON/USD perpetual, with 5× the shMON yield and a tighter liquidation buffer.',
    tvl: 3902000,
    holders: 1087,
    liqDropPct: 18,
    spark: [8, 10, 9, 14, 12, 16, 20, 18, 24, 30, 27, 33, 40],
  },
  {
    id: 'shMONx2.MON',
    ticker: 'shMONx2',
    quote: 'MON',
    debt: 'MON',
    leverage: 2,
    kind: 'loop',
    description:
      'Zero directional MON exposure. The long shMON and short MON legs cancel to give a pure, amplified shMON yield — equivalent to a 2× shMON/MON recursive deposit loop.',
    tvl: 7410000,
    holders: 2210,
    liqDropPct: 50,
    spark: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27],
  },
  {
    id: 'shMONx3.MON',
    ticker: 'shMONx3',
    quote: 'MON',
    debt: 'MON',
    leverage: 3,
    kind: 'loop',
    description:
      'A delta-neutral yield amplifier. Long 3 shMON, short 2 MON. Earns 3× the base APR with no exposure to MON price moves, funded by MON.b.shMON depositors.',
    tvl: 6925000,
    holders: 1920,
    liqDropPct: 33,
    spark: [18, 19, 20, 22, 23, 25, 26, 28, 30, 31, 33, 34, 36],
  },
  {
    id: 'shMONx5.MON',
    ticker: 'shMONx5',
    quote: 'MON',
    debt: 'MON',
    leverage: 5,
    kind: 'loop',
    description:
      'Maximum delta-neutral yield. Equivalent to a 5× looped shMON/MON position without the gas, rebalancing, or atomic borrow steps. Liquidates only if shMON depegs.',
    tvl: 8415000,
    holders: 3166,
    liqDropPct: 20,
    spark: [20, 22, 25, 28, 30, 34, 36, 40, 44, 47, 50, 52, 56],
  },
];

/* Derived metrics --------------------------------------------- */
function computeMetrics(m) {
  const borrow = m.debt === 'usd' ? USD_DEBT_BORROW : MON_DEBT_BORROW;
  const grossYield = m.leverage * SHMON_APR;
  const drag = (m.leverage - 1) * borrow;
  const netApr = grossYield - drag;

  return {
    borrow,
    grossYield,
    drag,
    netApr,
    debtRatio: (m.leverage - 1) / m.leverage,  // e.g. 0.8 for 5×
  };
}

/* ── Rendering helpers ──────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtPct = (n, digits = 2) => {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(digits)}%`;
};
const fmtTvl = (n) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};
const fmtNum = (n, digits = 4) => n.toLocaleString('en-US', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});

const tickerHtml = (id) => {
  const [base, quote] = id.split('.');
  return `${base}<span class="t-accent">.${quote}</span>`;
};

/* sparkline path */
function sparklinePath(values, width = 220, height = 36, pad = 2) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  const fill = d + ` L${last[0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`;
  return { line: d, fill };
}

/* ── Market grid ─────────────────────────────────────────────── */

function renderMarkets(filter = 'all') {
  const grid = $('#marketGrid');
  grid.innerHTML = '';

  const visible = markets.filter((m) =>
    filter === 'all' ? true : filter === 'usd' ? m.debt === 'usd' : m.debt === 'MON'
  );

  visible.forEach((m) => {
    const metrics = computeMetrics(m);
    const spark = sparklinePath(m.spark);
    const kindLabel = m.kind === 'perp' ? 'Perp-like' : 'Loop-like';
    const kindClass = m.kind === 'perp' ? 'perp' : 'loop';

    const el = document.createElement('button');
    el.className = 'market-card' + (m.id === state.selected ? ' selected' : '');
    el.dataset.id = m.id;
    el.type = 'button';
    el.innerHTML = `
      <div class="mc-head">
        <div>
          <div class="mc-ticker">${tickerHtml(m.id)}</div>
          <div class="mc-sub">${m.leverage}× ${m.quote === 'usd' ? 'MON/USD price + yield' : 'shMON yield · MON-neutral'}</div>
        </div>
        <span class="mc-badge ${kindClass}">${kindLabel}</span>
      </div>

      <div class="mc-headline">
        <div class="mc-apr pos">${fmtPct(metrics.netApr)}</div>
        <div class="mc-apr-label">Net APR</div>
      </div>

      <svg class="mc-spark" viewBox="0 0 220 36" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="grad-${m.id}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="var(--accent)" stop-opacity="0.28"/>
            <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${spark.fill}" fill="url(#grad-${m.id})" />
        <path d="${spark.line}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>

      <div class="mc-stats">
        <div>
          <div class="mc-stat-label">Gross yield</div>
          <div class="mc-stat-value">${fmtPct(metrics.grossYield)}</div>
        </div>
        <div>
          <div class="mc-stat-label">Borrow drag</div>
          <div class="mc-stat-value neg">${fmtPct(-metrics.drag)}</div>
        </div>
        <div>
          <div class="mc-stat-label">Liq. buffer</div>
          <div class="mc-stat-value">${m.quote === 'usd' ? `MON −${m.liqDropPct}%` : `shMON −${m.liqDropPct}%`}</div>
        </div>
        <div>
          <div class="mc-stat-label">TVL</div>
          <div class="mc-stat-value">${fmtTvl(m.tvl)}</div>
        </div>
      </div>

      <div class="mc-foot">
        <span>${m.holders.toLocaleString()} holders</span>
        <span class="mc-open">Open →</span>
      </div>
    `;
    el.addEventListener('click', () => selectMarket(m.id));
    grid.appendChild(el);
  });

  $('.section-foot .mono-dim').textContent = `${visible.length} / ${markets.length} shown`;
}

/* ── Detail panel ────────────────────────────────────────────── */

function renderDetail() {
  const m = markets.find((x) => x.id === state.selected);
  if (!m) return;
  const metrics = computeMetrics(m);

  const exposureRows = m.quote === 'usd'
    ? [
        { label: 'Long leg', detail: `${m.leverage.toFixed(1)}× shMON`, val: `${(m.leverage).toFixed(2)} × shMON/MON price` },
        { label: 'Short leg', detail: `${(m.leverage - 1).toFixed(1)}× USD`, val: `${(m.leverage - 1).toFixed(2)} × USD debt` },
        { label: 'Net MON/USD', detail: 'Price exposure', val: `${m.leverage.toFixed(1)}× long` },
        { label: 'Net shMON yield', detail: 'Yield exposure', val: `${m.leverage.toFixed(1)}× base APR` },
      ]
    : [
        { label: 'Long leg', detail: `${m.leverage.toFixed(1)}× shMON`, val: `${(m.leverage).toFixed(2)} × shMON` },
        { label: 'Short leg', detail: `${(m.leverage - 1).toFixed(1)}× MON`, val: `${(m.leverage - 1).toFixed(2)} × MON debt` },
        { label: 'Net MON/USD', detail: 'Price exposure', val: '0 (delta-neutral)' },
        { label: 'Net shMON yield', detail: 'Yield exposure', val: `${m.leverage.toFixed(1)}× base APR` },
      ];

  const inner = $('#detailInner');
  inner.innerHTML = `
    <div class="d-left">
      <div class="d-header">
        <div>
          <div class="d-title">${tickerHtml(m.id)}</div>
          <div class="d-sub">${m.description}</div>
        </div>
        <span class="mc-badge ${m.kind === 'perp' ? 'perp' : 'loop'}">${m.kind === 'perp' ? 'Perp-like' : 'Loop-like'}</span>
      </div>

      <div class="d-kpis">
        <div class="d-kpi">
          <div class="kpi-label">Net APR</div>
          <div class="kpi-value pos">${fmtPct(metrics.netApr)}</div>
        </div>
        <div class="d-kpi">
          <div class="kpi-label">Gross yield</div>
          <div class="kpi-value">${fmtPct(metrics.grossYield)}</div>
        </div>
        <div class="d-kpi">
          <div class="kpi-label">Borrow rate</div>
          <div class="kpi-value">${fmtPct(-metrics.borrow)} <span class="mono-dim" style="font-size:11px;">/ unit debt</span></div>
        </div>
        <div class="d-kpi">
          <div class="kpi-label">TVL</div>
          <div class="kpi-value">${fmtTvl(m.tvl)}</div>
        </div>
      </div>

      <div class="d-section-title">Exposure breakdown</div>
      <table class="d-pos-table">
        <thead>
          <tr><th>Leg</th><th>Position</th><th class="num">Size per unit</th></tr>
        </thead>
        <tbody>
          ${exposureRows.map(r => `
            <tr>
              <td>${r.label}</td>
              <td>${r.detail}</td>
              <td class="num">${r.val}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="d-section-title">Risk parameters</div>
      <div class="d-risk-grid">
        <div class="risk-card">
          <div class="rc-label">Liquidation trigger</div>
          <div class="rc-value">${m.quote === 'usd' ? 'MON' : 'shMON peg'} −${m.liqDropPct}%</div>
          <div class="rc-note">${m.quote === 'usd' ? 'Relative to mint price of MON/USD.' : 'Requires shMON re-denomination vs MON to break.'}</div>
        </div>
        <div class="risk-card">
          <div class="rc-label">Rebalancing</div>
          <div class="rc-value">Continuous</div>
          <div class="rc-note">No discrete rebalance — index tracks via NAV accrual.</div>
        </div>
        <div class="risk-card">
          <div class="rc-label">Paired yieldcoin</div>
          <div class="rc-value mono">${m.debt === 'usd' ? 'USD.b.shMON' : 'MON.b.shMON'}</div>
          <div class="rc-note">Earns ${fmtPct(metrics.borrow)} paid from this market's interest.</div>
        </div>
      </div>
    </div>

    <aside class="mint-card" aria-label="Mint / redeem">
      <div class="mint-tabs" role="tablist">
        <button class="mint-tab ${state.mintMode === 'mint' ? 'active' : ''}" data-mode="mint" type="button">Mint</button>
        <button class="mint-tab ${state.mintMode === 'redeem' ? 'active' : ''}" data-mode="redeem" type="button">Redeem</button>
      </div>

      <div class="input-group">
        <div class="input-group-label">
          <span>${state.mintMode === 'mint' ? 'You pay' : 'You burn'}</span>
          <span class="input-balance">
            Balance: <span class="mono">0.00</span>
            <span class="max-btn">MAX</span>
          </span>
        </div>
        <div class="input-row">
          <input id="amountIn" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${state.amountIn || ''}" />
          <span class="asset-pill">
            <span class="ap-dot"></span>
            ${state.mintMode === 'mint' ? 'shMON' : m.id}
          </span>
        </div>
      </div>

      <div class="arrow-sep" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>

      <div class="input-group">
        <div class="input-group-label">
          <span>${state.mintMode === 'mint' ? 'You receive' : 'You receive'}</span>
          <span class="input-balance mono" id="rateHint">1 shMON = 1.0000 ${m.id.split('.')[0]}</span>
        </div>
        <div class="input-row">
          <input id="amountOut" type="text" inputmode="decimal" placeholder="0.00" readonly />
          <span class="asset-pill receive">
            <span class="ap-dot"></span>
            ${state.mintMode === 'mint' ? m.id : 'shMON'}
          </span>
        </div>
      </div>

      <div class="summary">
        <div class="sum-row">
          <span class="sum-label">Exposure after mint</span>
          <span class="sum-value">${m.leverage.toFixed(1)}× shMON</span>
        </div>
        <div class="sum-row">
          <span class="sum-label">Liquidation trigger</span>
          <span class="sum-value warn">${m.quote === 'usd' ? 'MON' : 'shMON peg'} −${m.liqDropPct}%</span>
        </div>
        <div class="sum-row">
          <span class="sum-label">Mint fee</span>
          <span class="sum-value">0.05%</span>
        </div>
        <div class="sum-row emphasis">
          <span class="sum-label">Est. net APR</span>
          <span class="sum-value">${fmtPct(metrics.netApr)}</span>
        </div>
      </div>

      <button class="btn btn-primary btn-block" type="button">Connect wallet to ${state.mintMode}</button>

      <p class="disclaimer">
        This is a design preview. APRs are variable and depend on utilization. Always read the docs before minting.
      </p>
    </aside>
  `;

  // wire mint tabs
  $$('.mint-tab', inner).forEach((b) =>
    b.addEventListener('click', () => {
      state.mintMode = b.dataset.mode;
      renderDetail();
    })
  );

  // live-calculate output amount
  const inEl = $('#amountIn', inner);
  const outEl = $('#amountOut', inner);
  const rateHint = $('#rateHint', inner);
  // mint: 1 shMON → leverage × shMONxN (approx, 1:1 per unit collateral after leverage)
  const mintRate = state.mintMode === 'mint' ? m.leverage : 1 / m.leverage;
  rateHint.textContent = state.mintMode === 'mint'
    ? `1 shMON → ${mintRate.toFixed(4)} ${m.id}`
    : `1 ${m.id} → ${mintRate.toFixed(4)} shMON`;

  const recompute = () => {
    const v = parseFloat(inEl.value);
    if (!isFinite(v) || v <= 0) { outEl.value = ''; state.amountIn = ''; return; }
    state.amountIn = inEl.value;
    outEl.value = (v * mintRate).toLocaleString('en-US', {
      minimumFractionDigits: 4, maximumFractionDigits: 4,
    });
  };
  inEl.addEventListener('input', recompute);
  recompute();
}

/* ── State + events ─────────────────────────────────────────── */

const state = {
  selected: 'shMONx2.usd',
  filter: 'all',
  mintMode: 'mint',
  amountIn: '1.00',
};

function selectMarket(id) {
  state.selected = id;
  $$('.market-card').forEach((c) =>
    c.classList.toggle('selected', c.dataset.id === id)
  );
  renderDetail();
  // smooth scroll to detail panel on click
  const target = $('#detail');
  if (target) {
    const y = target.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }
}

function bindFilters() {
  $$('.chip.filter').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.chip.filter').forEach((x) => x.classList.toggle('active', x === b));
      state.filter = b.dataset.filter;
      renderMarkets(state.filter);
    })
  );
}

/* ── Init ────────────────────────────────────────────────────── */

function init() {
  renderMarkets(state.filter);
  renderDetail();
  bindFilters();

  // rotating "updated" tag (mockup flavor)
  const tag = $('#lastUpdated');
  const stamps = ['updated just now', 'updated 2s ago', 'updated 5s ago', 'updated 9s ago'];
  let i = 0;
  setInterval(() => {
    i = (i + 1) % stamps.length;
    if (tag) tag.textContent = stamps[i];
  }, 3000);
}

document.addEventListener('DOMContentLoaded', init);
