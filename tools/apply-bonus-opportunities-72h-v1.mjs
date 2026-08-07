import fs from 'node:fs';

const CLIENT = 'lib/baseReadyBonusClient.js';
const PAGE = 'app/arka/bonuset/page.jsx';
const MARKER = 'BONUS_OPPORTUNITIES_72H_V1';

function once(source, from, to, label) {
  if (source.includes(to)) return source;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  console.log(`PATCH ${label}`);
  return source.replace(from, to);
}

let client = fs.readFileSync(CLIENT, 'utf8');
if (!client.includes(`${MARKER}:CLIENT`)) {
  client = once(
    client,
    "const SUMMARY_CACHE_PREFIX = 'tepiha_base_ready_bonus_summary_v1:';",
    "const SUMMARY_CACHE_PREFIX = 'tepiha_base_ready_bonus_summary_v1:';\nconst OPPORTUNITY_CACHE_KEY = 'tepiha_base_bonus_opportunities_v1';\n// BONUS_OPPORTUNITIES_72H_V1:CLIENT",
    'bonus opportunities cache marker',
  );

  const anchor = `export async function listOpenBaseReadyBonusPayments(actorPin) {`;
  const helper = `export async function getBaseBonusOpportunities({ actorPin = '' } = {}) {
  const actor = text(actorPin || getActor()?.pin);
  if (!actor) throw new Error('MUNGON PIN-I PËR LISTËN E BONUSIT.');

  if (isOnline()) {
    const { data, error } = await supabase.rpc('get_base_bonus_opportunities_v1', {
      p_actor_pin: actor,
    });
    if (!error && data?.ok) {
      writeJson(OPPORTUNITY_CACHE_KEY, { saved_at: new Date().toISOString(), data });
      return { ...data, _offlineSnapshot: false };
    }
  }

  const cached = readJson(OPPORTUNITY_CACHE_KEY, null);
  if (cached?.data) return { ...cached.data, _offlineSnapshot: true, _cachedAt: cached.saved_at || null };
  return { ok: true, rows: [], config: null, _offlineSnapshot: true };
}

`;
  if (!client.includes(anchor)) throw new Error('CLIENT_OPPORTUNITY_ANCHOR_NOT_FOUND');
  client = client.replace(anchor, `${helper}${anchor}`);
  fs.writeFileSync(CLIENT, client, 'utf8');
}

let page = fs.readFileSync(PAGE, 'utf8');
if (!page.includes(`${MARKER}:PAGE`)) {
  page = once(
    page,
    `  getBaseReadyBonusSummary,\n  isBaseReadyBonusWorkerRole,`,
    `  getBaseReadyBonusSummary,\n  getBaseBonusOpportunities,\n  isBaseReadyBonusWorkerRole,`,
    'bonus page opportunity import',
  );

  page = once(
    page,
    `  const [summary, setSummary] = useState(null);`,
    `  const [summary, setSummary] = useState(null);\n  const [opportunities, setOpportunities] = useState(null);\n  // ${MARKER}:PAGE`,
    'bonus page opportunity state',
  );

  const oldLoad = `      const data = await getBaseReadyBonusSummary({
        actorPin: actor.pin,
        workerPin: target,
        date: dateKey,
        allowCache: true,
      });
      setSummary(data);
      setLastLiveAt(data?.generated_at || new Date().toISOString());`;
  const newLoad = `      const [data, opportunityData] = await Promise.all([
        getBaseReadyBonusSummary({
          actorPin: actor.pin,
          workerPin: target,
          date: dateKey,
          allowCache: true,
        }),
        getBaseBonusOpportunities({ actorPin: actor.pin }),
      ]);
      setSummary(data);
      setOpportunities(opportunityData);
      setLastLiveAt(data?.generated_at || opportunityData?.generated_at || new Date().toISOString());`;
  page = once(page, oldLoad, newLoad, 'load bonus summary plus opportunities');

  page = once(
    page,
    `  const rows = Array.isArray(summary?.rows) ? summary.rows : [];`,
    `  const rows = Array.isArray(summary?.rows) ? summary.rows : [];\n  const opportunityRows = Array.isArray(opportunities?.rows) ? opportunities.rows : [];\n  const windowHours = Number(opportunities?.config?.window_hours || summary?.config?.window_hours || BASE_READY_BONUS_WINDOW_HOURS) || BASE_READY_BONUS_WINDOW_HOURS;`,
    'derive live bonus window and opportunity rows',
  );

  page = page.replaceAll('<h1>BONUSI 48H</h1>', '<h1>BONUSI {windowHours}H</h1>');
  page = page.replace(
    `<p>{BASE_READY_BONUS_RATE_M2.toFixed(2)}€ për m² • porosia BAZA • GATI brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve • bonus në pagesën e plotë</p>`,
    `<p>{BASE_READY_BONUS_RATE_M2.toFixed(2)}€ për m² • porosia BAZA • pagesa e plotë brenda {windowHours} orëve</p>`,
  );

  const insertAnchor = `            <section className="bonusPanel">
              <div className="bonusPanelHead">
                <div>
                  <h2>{selectedWorker ? String(selectedWorker.name || selectedWorker.pin).toUpperCase() : canManage ? 'POROSITË E DITËS' : String(actor?.name || 'POROSITË E MIA').toUpperCase()}</h2>`;
  const opportunitySection = `            {dateKey === todayKey() ? (
              <section className="bonusPanel">
                <div className="bonusPanelHead">
                  <div>
                    <h2>MUNDËSITË PËR BONUS</h2>
                    <p>Klientët që ende mund ta kapin bonusin. Renditen sipas kohës që u ka mbetur.</p>
                  </div>
                  <div className="bonusCount">{opportunityRows.length} KLIENTË</div>
                </div>
                <div className="bonusRows">
                  {opportunityRows.length ? opportunityRows.map((row) => {
                    const hours = Math.max(0, Number(row?.hours_left || 0));
                    const urgent = hours <= 6;
                    return (
                      <article key={\`opportunity_\${row.order_id}\`} className="bonusRow">
                        <div className="bonusRowTop">
                          <div>
                            <div className="bonusOrder">#{row.order_code || '—'} — {String(row.client_name || 'KLIENT').toUpperCase()}</div>
                            <div className="bonusSmall">STATUS {String(row.status || '—').toUpperCase()} • AFATI {stamp(row.deadline_at)}</div>
                          </div>
                          <div className={\`bonusStatus \${urgent ? 'bad' : hours <= 18 ? 'warn' : 'ok'}\`}>{hours.toFixed(1)}h MBETUR</div>
                        </div>
                        <div className="bonusRowGrid">
                          <div><span>METRA</span><b>{m2(row.m2)}</b></div>
                          <div><span>BONUSI</span><b>{euro(row.potential_bonus)}</b></div>
                          <div><span>BORXHI</span><b>{euro(row.debt)}</b></div>
                          <div><span>AFATI</span><b>{hours.toFixed(1)}h</b></div>
                        </div>
                      </article>
                    );
                  }) : <div className="bonusEmpty">S’KA KLIENTË AKTIVË BRENDA AFATIT TË BONUSIT.</div>}
                </div>
              </section>
            ) : null}

`;
  if (!page.includes(insertAnchor)) throw new Error('PAGE_OPPORTUNITY_INSERT_ANCHOR_NOT_FOUND');
  page = page.replace(insertAnchor, `${opportunitySection}${insertAnchor}`);

  page = page.replaceAll('GATI brenda 48 orëve mbetet kushti i kualifikimit.', 'Pagesa e plotë brenda afatit aktiv të bonusit e kualifikon porosinë.');
  page = page.replaceAll('PIN-i që regjistron pagesën e plotë merr 0.10€ për m² kur porosia është bërë GATI brenda 48 orëve.', 'PIN-i që regjistron pagesën e plotë merr 0.10€ për m² kur pagesa bëhet brenda afatit aktiv të bonusit.');

  fs.writeFileSync(PAGE, page, 'utf8');
}

const clientAfter = fs.readFileSync(CLIENT, 'utf8');
const pageAfter = fs.readFileSync(PAGE, 'utf8');
for (const token of [
  'getBaseBonusOpportunities',
  "supabase.rpc('get_base_bonus_opportunities_v1'",
  'BONUS_OPPORTUNITIES_72H_V1:CLIENT',
]) {
  if (!clientAfter.includes(token)) throw new Error(`CLIENT_VERIFY_MISSING:${token}`);
}
for (const token of [
  'BONUS_OPPORTUNITIES_72H_V1:PAGE',
  'MUNDËSITË PËR BONUS',
  'hours_left',
  'potential_bonus',
  'windowHours',
]) {
  if (!pageAfter.includes(token)) throw new Error(`PAGE_VERIFY_MISSING:${token}`);
}
console.log('PASS live bonus opportunities show remaining hours and potential bonus');
