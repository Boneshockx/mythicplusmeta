<script setup>
import { computed, onMounted, ref, watch } from 'vue';

const regions = [
  { id: 'all', label: 'All regions' },
  { id: 'us', label: 'North America (US)' },
  { id: 'eu', label: 'Europe' },
  { id: 'tw', label: 'Taiwan' },
  { id: 'kr', label: 'Korea' },
  { id: 'cn', label: 'China' }
];
const classKeys = {
  'Death Knight': 'deathknight', 'Demon Hunter': 'demonhunter', Druid: 'druid', Evoker: 'evoker',
  Hunter: 'hunter', Mage: 'mage', Monk: 'monk', Paladin: 'paladin', Priest: 'priest',
  Rogue: 'rogue', Shaman: 'shaman', Warlock: 'warlock', Warrior: 'warrior'
};
const specIcons = {
  'Death Knight': { Blood: 'spell_deathknight_bloodpresence', Frost: 'spell_deathknight_frostpresence', Unholy: 'spell_deathknight_unholypresence' },
  'Demon Hunter': { Havoc: 'ability_demonhunter_specdps', Vengeance: 'ability_demonhunter_spectank', Devourer: 'classicon_demonhunter_void' },
  Druid: { Balance: 'spell_nature_starfall', Feral: 'ability_druid_catform', Guardian: 'ability_racial_bearform', Restoration: 'spell_nature_healingtouch' },
  Evoker: { Devastation: 'classicon_evoker_devastation', Preservation: 'classicon_evoker_preservation', Augmentation: 'classicon_evoker_augmentation' },
  Hunter: { 'Beast Mastery': 'ability_hunter_beasttaming', Marksmanship: 'ability_marksmanship', Survival: 'ability_hunter_swiftstrike' },
  Mage: { Arcane: 'spell_holy_magicalsentry', Fire: 'spell_fire_firebolt02', Frost: 'spell_frost_frostbolt02' },
  Monk: { Brewmaster: 'spell_monk_brewmaster_spec', Mistweaver: 'spell_monk_mistweaver_spec', Windwalker: 'spell_monk_windwalker_spec' },
  Paladin: { Holy: 'spell_holy_holybolt', Protection: 'ability_paladin_shieldofthetemplar', Retribution: 'spell_holy_auraoflight' },
  Priest: { Discipline: 'spell_holy_powerwordshield', Holy: 'spell_holy_guardianspirit', Shadow: 'spell_shadow_shadowwordpain' },
  Rogue: { Assassination: 'ability_rogue_deadlybrew', Outlaw: 'ability_rogue_waylay', Subtlety: 'ability_stealth' },
  Shaman: { Elemental: 'spell_nature_lightning', Enhancement: 'spell_shaman_improvedstormstrike', Restoration: 'spell_nature_magicimmunity' },
  Warlock: { Affliction: 'spell_shadow_deathcoil', Demonology: 'spell_shadow_metamorphosis', Destruction: 'spell_shadow_rainoffire' },
  Warrior: { Arms: 'ability_warrior_savageblow', Fury: 'ability_warrior_innerrage', Protection: 'ability_warrior_defensivestance' }
};
const classColors = {
  'Death Knight': '#c41e3a', 'Demon Hunter': '#a330c9', Druid: '#ff7c0a', Evoker: '#33937f',
  Hunter: '#aad372', Mage: '#3fc7eb', Monk: '#00ff98', Paladin: '#f48cba', Priest: '#eeeeee',
  Rogue: '#fff468', Shaman: '#0070dd', Warlock: '#8788ee', Warrior: '#c69b6d'
};
const meleeSpecs = new Set(['Arms Warrior', 'Fury Warrior', 'Feral Druid', 'Enhancement Shaman', 'Windwalker Monk', 'Brewmaster Monk', 'Mistweaver Monk', 'Havoc Demon Hunter', 'Vengeance Demon Hunter', 'Devourer Demon Hunter', 'Subtlety Rogue', 'Outlaw Rogue', 'Assassination Rogue', 'Retribution Paladin', 'Blood Death Knight', 'Frost Death Knight', 'Unholy Death Knight', 'Survival Hunter']);
const historyClassColors = {
  'Death Knight': '#f5224e', 'Demon Hunter': '#d83df2', Druid: '#ff7900', Evoker: '#00d6a4',
  Hunter: '#b9eb55', Mage: '#39d8ff', Monk: '#00f59a', Paladin: '#ff7ab8', Priest: '#e8ecf6',
  Rogue: '#fff04a', Shaman: '#087cf0', Warlock: '#a552ed', Warrior: '#d7a36e'
};
const region = ref('all');
const data = ref(null);
const dashboardDungeons = computed(() => {
  const dungeons = data.value?.dungeons || [];
  if (!dungeons.length) return [];
  const averageKeys = dungeons.map((dungeon) => dungeon.averageLevel);
  const timedDungeons = dungeons.filter((dungeon) => dungeon.averageTimeRemainingMs !== null && dungeon.timeLimitMs);
  const margins = timedDungeons.map((dungeon) => dungeon.averageTimeRemainingMs / dungeon.timeLimitMs * 100);
  const minKey = Math.min(...averageKeys);
  const maxKey = Math.max(...averageKeys);
  const minMargin = margins.length ? Math.min(...margins) : 0;
  const maxMargin = margins.length ? Math.max(...margins) : 0;
  return dungeons.map((dungeon) => {
    const keyScore = maxKey === minKey ? 50 : (dungeon.averageLevel - minKey) / (maxKey - minKey) * 100;
    const averageTimeRemainingPct = dungeon.averageTimeRemainingMs !== null && dungeon.timeLimitMs
      ? dungeon.averageTimeRemainingMs / dungeon.timeLimitMs * 100 : null;
    const marginScore = averageTimeRemainingPct === null || maxMargin === minMargin
      ? null : (averageTimeRemainingPct - minMargin) / (maxMargin - minMargin) * 100;
    return { ...dungeon, averageTimeRemainingPct, easeScore: marginScore === null ? keyScore : (keyScore + marginScore) / 2 };
  }).sort((a, b) => b.easeScore - a.easeScore || b.runs - a.runs)
    .map((dungeon, index) => ({ ...dungeon, easeRank: index + 1 }));
});
const easiestDashboardDungeon = computed(() => dashboardDungeons.value[0] || null);
const hardestDashboardDungeon = computed(() => dashboardDungeons.value.at(-1) || null);
const fastestDashboardDungeon = computed(() => [...dashboardDungeons.value]
  .filter((dungeon) => dungeon.averageTimeRemainingPct !== null)
  .sort((a, b) => b.averageTimeRemainingPct - a.averageTimeRemainingPct)[0] || null);
const regionWindowsByProgress = computed(() => [...(data.value?.regionWindows || [])].sort((a, b) => {
  const progress = (window) => (Date.now() - window.start) / Math.max(1, window.end - window.start);
  return progress(b) - progress(a);
}));
const periodRows = ref([]);
const currentPeriodId = ref(null);
const weeklyData = ref(null);
const historyRows = ref([]);
const weeklyRegion = ref('all');
const weeklySortBy = ref(null);
const weeklySortDirection = ref('desc');
const weeklyPage = ref(1);
const historyRegion = ref('all');
const weeklyLoading = ref(false);
const weeklyError = ref('');
const historyTooltip = ref(null);
let historyZoomTimer;
let historyScrollFrame;
const loading = ref(false);
const error = ref('');
const activeSection = ref('overview');
const routePath = () => window.location.pathname.replace(/\/$/, '') || '/';
const currentPage = ref(routePath() === '/methodology' ? 'methodology' : routePath() === '/periods' ? 'periods' : routePath() === '/history' ? 'history' : routePath().startsWith('/period/') ? 'week' : 'dashboard');
const sortedWeeklyComps = computed(() => {
  const comps = [...(weeklyData.value?.topComps || [])];
  if (!weeklySortBy.value) return comps;
  const fields = { rank: 'metaRank', runs: 'count', share: 'share', average: 'averageLevel', score: 'metaScore', highest: 'maxLevel' };
  const field = fields[weeklySortBy.value];
  return comps.sort((a, b) => {
    const result = Number(a[field] || 0) - Number(b[field] || 0);
    if (result) return weeklySortDirection.value === 'asc' ? result : -result;
    return a.metaRank - b.metaRank;
  });
});
const weeklyTotalPages = computed(() => Math.max(1, Math.ceil(sortedWeeklyComps.value.length / 20)));
const visibleWeeklyComps = computed(() => sortedWeeklyComps.value.slice((weeklyPage.value - 1) * 20, weeklyPage.value * 20));
const diversityPoints = computed(() => {
  const points = data.value?.diversity || [];
  if (!points.length) return [];
  const minX = points[0].level;
  const maxX = points[points.length - 1].level || minX + 1;
  const maxY = Math.max(0.1, ...points.map((p) => p.gini));
  return points.map((point) => ({
    ...point,
    x: 48 + ((point.level - minX) / Math.max(1, maxX - minX)) * 704,
    y: 212 - (point.gini / maxY) * 166,
    labelY: 236
  }));
});
const diversityLine = computed(() => diversityPoints.value.map((p) => `${p.x},${p.y}`).join(' '));
const historyBars = computed(() => {
  const rows = historyRows.value;
  if (!rows.length) return { bars: [] };
  const colorFor = (key) => {
    const className = Object.keys(classColors).find((name) => key.endsWith(` ${name}`));
    return historyClassColors[className] || '#68778b';
  };
  const bars = [...rows].sort((a, b) => b.start - a.start).map((row) => {
    const specs = row.specs.filter((spec) => spec.share > 0);
    const topSpecs = new Set([...specs].sort((a, b) => b.share - a.share).slice(0, 5).map((spec) => spec.key));
    const segments = specs.map((spec) => {
      const className = Object.keys(classColors).find((name) => spec.key.endsWith(` ${name}`));
      const specName = className ? spec.key.slice(0, -(className.length + 1)) : spec.key;
      return { key: spec.key, spec: specName, className, color: colorFor(spec.key), share: spec.share, isTopFive: topSpecs.has(spec.key) };
    });
    return { ...row, segments };
  });
  return { bars };
});
const weeklyDiversityRows = computed(() => [...(weeklyData.value?.diversity || [])].sort((a, b) => b.level - a.level).map((point) => {
  const specs = (point.specs || []).filter((spec) => spec.share > 0);
  const topSpecs = new Set([...specs].sort((a, b) => b.share - a.share).slice(0, 5).map((spec) => spec.key));
  return {
    ...point,
    segments: specs.map((spec) => {
      const className = Object.keys(classKeys).find((name) => spec.key.endsWith(` ${name}`));
      const specName = className ? spec.key.slice(0, -(className.length + 1)) : spec.key;
      return { key: spec.key, spec: specName, className, share: spec.share, isTopFive: topSpecs.has(spec.key), color: historyClassColors[className] || '#68778b' };
    })
  };
}));
const makeRoleRepresentation = (specs = []) => {
  const roles = ['ranged', 'melee', 'healer', 'tank'];
  const groups = new Map(roles.map((role) => [role, { role, appearances: 0, specs: [] }]));
  const totalSlots = specs.reduce((sum, spec) => sum + Number(spec.appearances || 0), 0);
  for (const spec of specs) {
    const role = spec.role === 'tank' || spec.role === 'healer'
      ? spec.role
      : meleeSpecs.has(`${spec.spec} ${spec.class}`) ? 'melee' : 'ranged';
    const group = groups.get(role);
    group.appearances += Number(spec.appearances || 0);
    group.specs.push(spec);
  }
  return roles.map((role) => {
    const group = groups.get(role);
    const topSpecs = new Set([...group.specs].sort((a, b) => b.appearances - a.appearances).slice(0, 5).map((spec) => `${spec.spec} ${spec.class}`));
    return {
      ...group,
      pickRate: totalSlots ? group.appearances / totalSlots * 100 : 0,
      segments: [...group.specs].sort((a, b) => Number(b.appearances || 0) - Number(a.appearances || 0)).map((spec) => ({
        spec: spec.spec, className: spec.class, roleLabel: role, color: historyClassColors[spec.class] || '#68778b',
        share: totalSlots ? Number(spec.appearances || 0) / totalSlots * 100 : 0,
        roleShare: group.appearances ? Number(spec.appearances || 0) / group.appearances * 100 : 0,
        isTopFive: topSpecs.has(`${spec.spec} ${spec.class}`)
      }))
    };
  });
};
const dashboardRoleRepresentation = computed(() => makeRoleRepresentation(data.value?.specs || []));
const weeklyRoleRepresentation = computed(() => makeRoleRepresentation(weeklyData.value?.specs || []));
const hoveredClass = ref(null);
const selectedClass = ref(null);
const classPieCircumference = 2 * Math.PI * 78;
const classPieSegments = computed(() => {
  const classes = data.value?.classes || [];
  const total = classes.reduce((sum, item) => sum + item.appearances, 0);
  let offset = 0;
  return classes.map((item) => {
    const share = total ? item.appearances / total * 100 : 0;
    const length = share / 100 * classPieCircumference;
    const angle = length / classPieCircumference * 360;
    const middleAngle = (offset / classPieCircumference * 360 + angle / 2) * Math.PI / 180;
    const segment = { ...item, share, offset, length: Math.max(0, length - 1.5), labelX: 120 + 78 * Math.cos(middleAngle), labelY: 120 + 78 * Math.sin(middleAngle), color: classColors[item.class] || '#68778b' };
    offset += length;
    return segment;
  });
});
const displayedClass = computed(() => {
  const classes = data.value?.classes || [];
  return classes.find((item) => item.class === hoveredClass.value)
    || classes.find((item) => item.class === selectedClass.value)
    || classes[0] || null;
});
const hardestWeeklyDungeon = computed(() => weeklyData.value?.dungeons?.at(-1) || null);
const fastestWeeklyDungeon = computed(() => (weeklyData.value?.dungeons || [])
  .filter((dungeon) => dungeon.averageTimeRemainingPct !== null && dungeon.averageTimeRemainingPct !== undefined)
  .sort((a, b) => b.averageTimeRemainingPct - a.averageTimeRemainingPct)[0] || null);

function classStyle(className) {
  return { '--class-color': classColors[className] || '#8b929c' };
}
function classIcon(className) {
  const key = classKeys[className];
  return key ? `https://wow.zamimg.com/images/wow/icons/medium/classicon_${key}.jpg` : '';
}
function specIcon(specName, className) {
  const icon = specIcons[className]?.[specName];
  return icon ? `https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg` : classIcon(className);
}
function handleIconError(event, className) {
  const fallback = classIcon(className);
  if (fallback && event.target.src !== fallback) {
    event.target.src = fallback;
  } else {
    event.target.hidden = true;
  }
}
function formatTime(milliseconds) {
  if (!milliseconds) return '—';
  const totalMinutes = Math.round(milliseconds / 60000);
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}
function formatRunDuration(milliseconds) {
  if (!milliseconds) return '—';
  const totalSeconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
function formatTimeDelta(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return '—';
  const sign = milliseconds >= 0 ? '+' : '−';
  return `${sign}${formatRunDuration(Math.abs(milliseconds))}`;
}
function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not synced yet';
}
function formatResetTime(value) {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))} UTC`;
}
function regionPeriodDay(window) {
  const now = Date.now();
  return Math.max(1, Math.min(7, Math.floor((now - window.start) / 86400000) + 1));
}
function regionPeriodTitle(window) {
  return `${window.region.toUpperCase()} reset period: ${formatResetTime(window.start)} – ${formatResetTime(window.end)}`;
}
function regionPeriodLabel(window) {
  return `${window.region.toUpperCase()} · Day ${regionPeriodDay(window)}`;
}
function showHistoryTooltip(event, segment) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const pointerEvent = event.type === 'mousemove' || event.type === 'mouseenter';
  const x = pointerEvent ? event.clientX : bounds.left + bounds.width / 2;
  const y = pointerEvent ? event.clientY : bounds.top + bounds.height / 2;
  historyTooltip.value = {
    spec: segment.spec,
    className: segment.className,
    share: segment.share,
    detail: segment.roleShare == null ? '' : `${segment.roleShare.toFixed(1)}% of ${segment.roleLabel || 'role'} slots`,
    left: Math.max(8, Math.min(window.innerWidth - 248, x + 14)),
    top: Math.max(8, Math.min(window.innerHeight - 104, y + 14))
  };
}
function zoomHistoryAtPointer(event) {
  const target = event.currentTarget;
  const track = target.parentElement;
  if (event.type === 'mouseenter' && track.dataset.historyZoomDone === 'true') return;
  if (event.type === 'mouseenter') track.dataset.historyZoomDone = 'true';
  const targetBounds = target.getBoundingClientRect();
  const pointerX = event.type === 'focus' ? targetBounds.left + targetBounds.width / 2 : event.clientX;
  clearTimeout(historyZoomTimer);
  cancelAnimationFrame(historyScrollFrame);
  historyZoomTimer = window.setTimeout(() => {
    const targetRect = target.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const segmentLeft = targetRect.left - trackRect.left + track.scrollLeft;
    const pointerOffset = pointerX - trackRect.left;
    const destination = segmentLeft + targetRect.width / 2 - pointerOffset;
    const start = track.scrollLeft;
    const change = destination - start;
    const startedAt = performance.now();
    const duration = 145;
    const animate = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      track.scrollLeft = start + change * eased;
      if (progress < 1) historyScrollFrame = requestAnimationFrame(animate);
    };
    historyScrollFrame = requestAnimationFrame(animate);
  }, 125);
}
function resetHistoryZoom(event) {
  delete event.currentTarget.dataset.historyZoomDone;
  clearTimeout(historyZoomTimer);
  cancelAnimationFrame(historyScrollFrame);
}
function moveHistoryTooltip(event) {
  if (!historyTooltip.value) return;
  historyTooltip.value = {
    ...historyTooltip.value,
    left: Math.max(8, Math.min(window.innerWidth - 248, event.clientX + 14)),
    top: Math.max(8, Math.min(window.innerHeight - 104, event.clientY + 14))
  };
}
function updateHistoryScrollHint(event) {
  const track = event.currentTarget.classList.contains('history-bar-track') || event.currentTarget.classList.contains('diversity-bar-track')
    ? event.currentTarget
    : event.currentTarget.querySelector('.history-bar-track, .diversity-bar-track');
  if (!track) return;
  requestAnimationFrame(() => {
    const scrollable = track.scrollWidth > track.clientWidth + 2;
    const atStart = track.scrollLeft <= 2;
    const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    for (const element of [track, track.parentElement]) {
      if (!element) continue;
      element.dataset.scrollable = String(scrollable);
      element.dataset.scrollStart = String(atStart);
      element.dataset.scrollEnd = String(atEnd);
    }
  });
}
function scrollHistoryTrack(event) {
  const track = event.currentTarget;
  track.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const periodsResponse = await fetch('/api/meta/periods');
    const periods = await periodsResponse.json();
    if (!periodsResponse.ok) throw new Error(periods.error || 'Could not load the current period.');
    periodRows.value = periods;
    const now = Date.now();
    const hasSelectedRegion = (period) => period.regionWindows.some((window) =>
      (region.value === 'all' || window.region === region.value) && window.end > now
    );
    const current = periods.find((period) => period.runCount > 0 && hasSelectedRegion(period))
      || periods.find((period) => period.runCount > 0 && (region.value === 'all' || period.regions.includes(region.value)));
    if (!current) throw new Error(`No current-period data is available for ${regions.find((item) => item.id === region.value)?.label || region.value}.`);
    currentPeriodId.value = current.periodId;
    const response = await fetch(`/api/meta/period/${current.periodId}?region=${encodeURIComponent(region.value)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load the current period.');
    const byClass = new Map();
    for (const spec of result.specs) {
      const group = byClass.get(spec.class) || { class: spec.class, appearances: 0, specs: [] };
      group.appearances += spec.appearances;
      group.specs.push({ ...spec, withinClass: group.appearances ? spec.appearances / (group.appearances) * 100 : 0 });
      byClass.set(spec.class, group);
    }
    const classes = [...byClass.values()].map((group) => {
      const total = group.appearances;
      return { ...group, pickRate: result.totalCharacters ? total / result.totalCharacters * 100 : 0,
        specs: group.specs.map((spec) => ({ ...spec, withinClass: total ? spec.appearances / total * 100 : 0 })) };
    }).sort((a, b) => b.appearances - a.appearances);
    data.value = {
      ...result,
      season: result.season,
      classes,
      availableKeyLevels: result.diversity.map((point) => point.level),
      minRunsForEstablished: Math.max(50, Math.ceil(result.sampleSize * 0.025))
    };
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
function navigateTo(section) {
  activeSection.value = section;
  document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openCurrentPeriodDetails() {
  if (!data.value?.periodId) return;
  weeklyRegion.value = region.value;
  navigatePage('week', data.value.periodId);
}
async function loadPeriods() {
  weeklyLoading.value = true;
  weeklyError.value = '';
  try {
    const response = await fetch('/api/meta/periods');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load weekly periods.');
    periodRows.value = result;
  } catch (err) { weeklyError.value = err.message; }
  finally { weeklyLoading.value = false; }
}
async function loadHistory() {
  weeklyLoading.value = true;
  weeklyError.value = '';
  try {
    const response = await fetch(`/api/meta/history?region=${encodeURIComponent(historyRegion.value)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load weekly history.');
    historyRows.value = result;
  } catch (err) { weeklyError.value = err.message; }
  finally { weeklyLoading.value = false; }
}
async function loadWeek(periodId) {
  weeklyPage.value = 1;
  weeklyLoading.value = true;
  weeklyError.value = '';
  try {
    const response = await fetch(`/api/meta/period/${encodeURIComponent(periodId)}?region=${encodeURIComponent(weeklyRegion.value)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load that week.');
    weeklyData.value = result;
  } catch (err) { weeklyData.value = null; weeklyError.value = err.message; }
  finally { weeklyLoading.value = false; }
}
function navigatePage(page, periodId = null) {
  const path = page === 'week' ? `/period/${periodId}` : page === 'dashboard' ? '/' : `/${page}`;
  if (window.location.pathname !== path) window.history.pushState({}, '', path);
  currentPage.value = page;
  document.title = page === 'methodology' ? 'How we calculate the meta | MythicPlusMeta' : page === 'periods' ? 'Weekly periods | MythicPlusMeta' : page === 'history' ? 'Meta history | MythicPlusMeta' : page === 'week' ? `Period ${periodId} | MythicPlusMeta` : 'MythicPlusMeta';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'periods') loadPeriods();
  if (page === 'history') loadHistory();
  if (page === 'week') loadWeek(periodId);
}
function sortComps(key) {
  weeklyPage.value = 1;
  if (weeklySortBy.value === key) {
    if (weeklySortDirection.value === 'desc') weeklySortDirection.value = 'asc';
    else weeklySortBy.value = null;
    return;
  }
  weeklySortBy.value = key;
  weeklySortDirection.value = 'desc';
}
function sortIndicator(key) {
  return weeklySortBy.value === key ? (weeklySortDirection.value === 'asc' ? '↑' : '↓') : '↕';
}
function syncPageWithHistory() {
  const path = routePath();
  currentPage.value = path === '/methodology' ? 'methodology' : path === '/periods' ? 'periods' : path === '/history' ? 'history' : path.startsWith('/period/') ? 'week' : 'dashboard';
  document.title = currentPage.value === 'methodology' ? 'How we calculate the meta | MythicPlusMeta' : currentPage.value === 'periods' ? 'Weekly periods | MythicPlusMeta' : currentPage.value === 'history' ? 'Meta history | MythicPlusMeta' : currentPage.value === 'week' ? `Period ${path.split('/').pop()} | MythicPlusMeta` : 'MythicPlusMeta';
  if (currentPage.value === 'periods') loadPeriods();
  if (currentPage.value === 'history') loadHistory();
  if (currentPage.value === 'week') loadWeek(path.split('/').pop());
}
watch(region, load);
onMounted(() => {
  load();
  syncPageWithHistory();
  window.addEventListener('popstate', syncPageWithHistory);
});
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell-wide': currentPage === 'history' }">
    <header class="site-header">
      <a class="brand" href="/" aria-label="MythicPlusMeta home" @click.prevent="navigatePage('dashboard')"><span class="brand-icon" aria-hidden="true">M<sup>+</sup>M</span><span class="brand-name">mythicplus<span>meta</span></span></a>
      <nav class="desktop-nav" aria-label="Main navigation">
        <button :class="{ active: currentPage === 'dashboard' }" @click="navigatePage('dashboard')">Dashboard</button>
        <button :class="{ active: currentPage === 'periods' || currentPage === 'week' }" @click="navigatePage('periods')">Weeks</button>
        <button :class="{ active: currentPage === 'history' }" @click="navigatePage('history')">History</button>
        <button :class="{ active: currentPage === 'methodology' }" @click="navigatePage('methodology')">Methodology</button>
      </nav>
    </header>

    <main v-if="currentPage === 'periods'" class="weekly-main">
      <div class="kicker"><span class="status-dot"></span> RESET-BY-RESET ARCHIVE</div>
      <h1>Weekly <span>periods</span></h1>
      <p class="weekly-lead">Each row is a World of Warcraft Mythic Keystone leaderboard period imported from Blizzard. Select a week to explore its top compositions, spec representation, diversity and dungeon highs.</p>
      <div v-if="weeklyError" class="notice error">{{ weeklyError }}</div><div v-else-if="weeklyLoading" class="notice">Loading weekly periods…</div>
      <div v-else-if="!periodRows.length" class="notice"><b>No weekly periods have been imported yet.</b><span>Add Blizzard OAuth credentials to `.env`, then run `npm run sync:weekly` to capture the latest period.</span></div>
      <div v-else class="table-scroll weekly-table-wrap"><table class="weekly-table"><thead><tr><th>Period</th><th>Week</th><th>Season</th><th>Top keys</th><th>Dungeons</th><th>Regional reset windows (UTC)</th></tr></thead><tbody>
        <tr v-for="period in periodRows" :key="period.periodId" @click="navigatePage('week', period.periodId)"><td><button class="period-link">{{ period.periodId }}</button></td><td><span v-if="!period.offSeason">Week {{ period.weekNumber ?? '—' }}</span><span v-else>—</span><span v-if="period.offSeason" class="off-season-badge" aria-label="This API period happened before the Mythic Plus season opened.">Off-season</span><span v-else-if="period.runCount === 0" class="no-mplus-badge" aria-label="No Mythic Plus leaderboard data is available for this period.">No M+ data</span></td><td>{{ period.season }}</td><td>{{ period.runCount.toLocaleString() }}</td><td>{{ period.dungeonCount }}</td><td><span class="reset-window" v-for="window in period.regionWindows" :key="window.region"><b>{{ window.region.toUpperCase() }}</b> {{ formatResetTime(window.start) }} → {{ formatResetTime(window.end) }}</span></td></tr>
      </tbody></table></div>
      <p class="weekly-footnote">The Blizzard leaderboard exposes at most 500 groups for each connected realm and dungeon. The imported total is combined across the selected regions; it is a leaderboard sample, not every completed key.</p>
    </main>

    <main v-else-if="currentPage === 'week'" class="weekly-main">
      <button class="back-to-dashboard" @click="navigatePage('periods')">← All periods</button>
      <div v-if="weeklyLoading" class="notice">Loading this weekly sample…</div><div v-else-if="weeklyError" class="notice error"><b>Weekly data is not available</b><span>{{ weeklyError }}</span></div>
      <template v-else-if="weeklyData">
        <div class="weekly-title-row"><div><div class="kicker"><span class="status-dot"></span> {{ weeklyData.season }} · {{ weeklyData.offSeason ? 'OFF-SEASON' : `WEEK ${weeklyData.weekNumber}` }} · RESET PERIOD</div><h1>Period {{ weeklyData.periodId }}</h1><p>Each region uses its own weekly reset window:</p><div class="weekly-window-chips"><span v-for="window in weeklyData.regionWindows" :key="window.region"><b>{{ window.region.toUpperCase() }}</b> {{ formatResetTime(window.start) }} – {{ formatResetTime(window.end) }}</span></div></div><label class="level-filter">Region <select v-model="weeklyRegion" @change="loadWeek(weeklyData.periodId)"><option value="all">All imported regions</option><option v-for="item in regions.filter((x) => x.id !== 'all')" :key="item.id" :value="item.id">{{ item.label }}</option></select></label></div>
        <div class="summary-grid"><article class="summary-card featured"><span class="summary-label">TOP KEYS</span><div class="summary-value">{{ weeklyData.sampleSize.toLocaleString() }}</div><div class="summary-foot">Imported leaderboard entries</div></article><article class="summary-card"><span class="summary-label">CHARACTER SLOTS</span><div class="summary-value">{{ weeklyData.totalCharacters.toLocaleString() }}</div><div class="summary-foot">Across selected period</div></article><article class="summary-card"><span class="summary-label">AVERAGE KEY</span><div class="summary-value">{{ weeklyData.averageLevel.toFixed(1) }}</div><div class="summary-foot">Selected period</div></article><article class="summary-card"><span class="summary-label">HIGHEST KEY</span><div class="summary-value">+{{ weeklyData.highestKey }}</div><div class="summary-foot">Selected period</div></article></div>
        <section class="panel"><div class="panel-heading"><div><span class="eyebrow">POPULARITY + PERFORMANCE</span><h2>Top meta compositions</h2><p>Meta score: 40% popularity, 40% average key difficulty, 20% highest key difficulty.</p></div></div><div class="table-scroll"><table class="comps-table"><thead><tr><th v-for="column in [{key:'rank',label:'Rank'},{key:'composition',label:'Composition'},{key:'runs',label:'Runs'},{key:'share',label:'Share'},{key:'average',label:'Avg key'},{key:'score',label:'Meta score'},{key:'highest',label:'Highest key'}]" :key="column.key" :aria-sort="column.key === 'composition' ? 'none' : weeklySortBy === column.key ? (weeklySortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"><button v-if="column.key !== 'composition'" class="table-sort" type="button" @click="sortComps(column.key)">{{ column.label }} <span aria-hidden="true">{{ sortIndicator(column.key) }}</span></button><span v-else>{{ column.label }}</span></th></tr></thead><tbody><tr v-for="comp in visibleWeeklyComps" :key="comp.composition.map((x) => x.spec + x.class).join('|')"><td class="rank-cell">{{ String(comp.metaRank).padStart(2, '0') }}</td><td><div class="party-composition"><div v-for="(player, index) in comp.composition" :key="index" class="spec-avatar" :style="classStyle(player.class)"><img :src="specIcon(player.spec, player.class)" alt="" loading="lazy" @error="handleIconError($event, player.class)"/><span>{{ player.spec }}</span></div></div></td><td>{{ comp.count }}</td><td>{{ comp.share.toFixed(1) }}%</td><td>{{ comp.averageLevel.toFixed(1) }}</td><td><b class="meta-score-value">{{ comp.metaScore.toFixed(1) }}</b></td><td><span class="key-pill">+{{ comp.maxLevel }}</span></td></tr><tr v-if="!weeklyData.topComps.length"><td colspan="7" class="empty-cell">No leaderboard entries were imported for this period.</td></tr></tbody></table></div><div v-if="weeklyData.topComps.length" class="comps-pagination"><span>Showing {{ (weeklyPage - 1) * 20 + 1 }}–{{ Math.min(weeklyPage * 20, sortedWeeklyComps.length) }} of {{ sortedWeeklyComps.length }} compositions</span><div><button type="button" :disabled="weeklyPage <= 1" @click="weeklyPage--">Previous</button><span>Page {{ weeklyPage }} of {{ weeklyTotalPages }}</span><button type="button" :disabled="weeklyPage >= weeklyTotalPages" @click="weeklyPage++">Next</button></div></div></section>
        <section class="analysis-grid weekly-analysis"><article class="panel"><div class="panel-heading"><div><span class="eyebrow">SPEC REPRESENTATION</span><h2>Who appears in the top keys?</h2><p>Each role has a horizontal bar per spec, scaled to that role. Hover for overall representation.</p></div></div><div class="role-spec-chart">
              <div v-for="group in weeklyRoleRepresentation" :key="group.role" class="role-spec-row">
                <div class="role-spec-heading"><b>{{ group.role }}</b><small>{{ group.pickRate.toFixed(1) }}% of all player slots</small></div>
                <div class="role-candle-chart">
                  <div v-for="segment in group.segments" :key="segment.spec + segment.className" class="role-candle-row" :aria-label="`${segment.spec} ${segment.className}: ${segment.share.toFixed(1)}% overall, ${segment.roleShare.toFixed(1)}% of ${group.role}`" tabindex="0" @mouseenter="showHistoryTooltip($event, segment)" @mousemove="moveHistoryTooltip" @mouseleave="historyTooltip = null" @focus="showHistoryTooltip($event, segment)" @blur="historyTooltip = null">
                    <img :src="specIcon(segment.spec, segment.className)" :alt="`${segment.spec} icon`" loading="lazy" @error="handleIconError($event, segment.className)"/><span class="role-candle-track"><i :style="{ '--spec-color': segment.color, width: `${segment.roleShare}%` }"><b>{{ segment.spec }}</b></i></span><strong>{{ segment.share.toFixed(1) }}%</strong>
                  </div>
                </div>
              </div>
            </div></article>
          <article class="panel"><div class="panel-heading"><div><span class="eyebrow">DIVERSITY PER KEY LEVEL</span><h2>Which specs make up each key?</h2><p>Each bar splits all five-player slots by spec. A lower Gini score means representation is more evenly spread.</p></div></div><div class="weekly-diversity-chart"><div v-for="point in weeklyDiversityRows" :key="point.level" class="weekly-diversity-row"><div class="weekly-diversity-key"><b>+{{ point.level }}</b><small>{{ point.runs.toLocaleString() }} runs</small></div><span class="diversity-bar-wrap" @mouseenter="updateHistoryScrollHint" @focusin="updateHistoryScrollHint"><span class="diversity-bar-track" @scroll="updateHistoryScrollHint" @wheel.prevent="scrollHistoryTrack" @mouseleave="resetHistoryZoom($event)"><span v-for="segment in point.segments" :key="segment.key" class="diversity-bar-segment" :class="{ 'top-five-spec': segment.isTopFive }" :style="{ width: `${segment.share}%`, background: segment.color }" :aria-label="`${segment.spec} ${segment.className}: ${segment.share.toFixed(1)}% at key +${point.level}`" role="img" tabindex="0" @mouseenter="zoomHistoryAtPointer($event); showHistoryTooltip($event, segment)" @mousemove="moveHistoryTooltip" @mouseleave="historyTooltip = null" @focus="zoomHistoryAtPointer($event); showHistoryTooltip($event, segment)" @blur="historyTooltip = null"><img :src="specIcon(segment.spec, segment.className)" alt="" loading="lazy" @error="handleIconError($event, segment.className)"/><small>{{ segment.share.toFixed(1) }}%</small></span></span><span class="diversity-scroll-hint diversity-scroll-left" aria-hidden="true">&#8249; Scroll</span><span class="diversity-scroll-hint diversity-scroll-right" aria-hidden="true">Scroll &#8250;</span></span><div class="weekly-diversity-gini"><small>GINI</small><b>{{ point.gini.toFixed(2) }}</b></div></div></div></article></section>
        <section class="panel"><div class="panel-heading"><div><span class="eyebrow">DUNGEON PERFORMANCE</span><h2>Which dungeons look easiest?</h2><p>Easiest and hardest use average key level and timer margin. Fastest means the greatest average percentage of the timer left, accounting for the different dungeon time limits. Leaderboard data includes clears only, so it cannot show true completion rates.</p></div></div><div class="dungeon-performance-list"><article v-for="dungeon in weeklyData.dungeons" :key="dungeon.dungeon" :class="{ 'easiest-dungeon': dungeon.easeRank === 1, 'hardest-dungeon': hardestWeeklyDungeon && dungeon.dungeon === hardestWeeklyDungeon.dungeon }"><div class="dungeon-rank">{{ String(dungeon.easeRank).padStart(2, '0') }}</div><div class="dungeon-name"><b>{{ dungeon.dungeon }}</b><div class="dungeon-badges"><span v-if="dungeon.easeRank === 1" class="dungeon-badge easiest-badge">Easiest</span><span v-if="hardestWeeklyDungeon && dungeon.dungeon === hardestWeeklyDungeon.dungeon" class="dungeon-badge hardest-badge">Hardest</span><span v-if="fastestWeeklyDungeon && dungeon.dungeon === fastestWeeklyDungeon.dungeon" class="dungeon-badge fastest-badge">Fastest (timer adjusted)</span></div></div><div class="dungeon-metric average-key-metric"><small>Average key</small><b>{{ dungeon.averageLevel.toFixed(1) }}</b></div><div class="dungeon-metric highest-key-metric"><small>Highest key</small><b>+{{ dungeon.maxLevel }}</b></div><div class="dungeon-metric time-limit-metric"><small>Time limit</small><b>{{ dungeon.timeLimitMs ? formatRunDuration(dungeon.timeLimitMs) : '—' }}</b></div><div class="dungeon-metric average-clear-time-metric"><small>Avg. clear time</small><b>{{ dungeon.averageClearTimeMs ? formatRunDuration(dungeon.averageClearTimeMs) : 'N/A' }}</b></div><div class="dungeon-metric average-time-left-metric"><small>Avg. time left</small><b>{{ formatTimeDelta(dungeon.averageTimeRemainingMs) }}</b><em v-if="dungeon.timedRuns">from {{ dungeon.timedRuns.toLocaleString() }} timed runs</em></div><div class="dungeon-metric most-time-left-metric"><small>Most time left</small><b>{{ formatTimeDelta(dungeon.maxTimeRemainingMs) }}</b><em v-if="dungeon.fastestRunLevel">on a +{{ dungeon.fastestRunLevel }} key</em></div><div class="dungeon-sample"><span>{{ dungeon.runs.toLocaleString() }}</span><small>runs in sample</small></div></article></div></section>
        <div v-if="historyTooltip" class="history-spec-tooltip" :style="{ left: `${historyTooltip.left}px`, top: `${historyTooltip.top}px` }" role="status"><img :src="specIcon(historyTooltip.spec, historyTooltip.className)" alt="" @error="handleIconError($event, historyTooltip.className)"/><span><b>{{ historyTooltip.spec }}</b><small>{{ historyTooltip.className }}</small><small v-if="historyTooltip.detail">{{ historyTooltip.detail }}</small></span><strong>{{ historyTooltip.share.toFixed(1) }}%</strong></div>
      </template>
    </main>

      <main v-else-if="currentPage === 'history'" class="weekly-main history-page" @mouseleave="historyTooltip = null">
      <div class="kicker"><span class="status-dot"></span> SEASON TRENDS</div>
      <h1>Meta <span>history</span></h1>
      <p class="weekly-lead">Compare the weekly specialization meta, highest completed key and diversity across periods.</p>
      <div v-if="weeklyError" class="notice error">{{ weeklyError }}</div>
      <div v-else-if="weeklyLoading" class="notice">Loading history...</div>
      <div v-else-if="!historyRows.length" class="notice"><b>No history has been imported yet.</b><span>Import weekly periods to compare the meta over time.</span></div>
      <template v-else>
        <section class="panel history-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">WEEKLY SPEC REPRESENTATION</span><h2>How the meta shifted</h2><p>Each bar shows the share of player slots for each specialization. Periods combine imported regions; choose a region to view its reset weeks alone.</p></div>
            <label class="level-filter">Region
              <select v-model="historyRegion" @change="loadHistory">
                <option value="all">All imported regions</option>
                <option v-for="item in regions.filter((x) => x.id !== 'all')" :key="item.id" :value="item.id">{{ item.label }}</option>
              </select>
            </label>
          </div>
          <div class="history-bars" role="group" aria-label="Stacked bars showing specialization representation by weekly period">
            <div class="history-bar-header"><span>PERIOD</span><span>PLAYER SLOT SHARE</span><span>RUNS / AVG KEY / HIGHEST / GINI</span></div>
            <button v-for="week in historyBars.bars" :key="week.periodId" class="history-bar-row" @click="navigatePage('week', week.periodId)">
              <span class="history-bar-label"><b>{{ week.periodId }}</b><small>{{ new Date(week.start).toLocaleDateString() }}</small></span>
              <span class="history-bar-track-wrap" @mouseenter="updateHistoryScrollHint" @focusin="updateHistoryScrollHint" @mousemove="updateHistoryScrollHint">
              <span class="history-bar-track" @scroll="updateHistoryScrollHint" @wheel.prevent="scrollHistoryTrack" @mouseleave="resetHistoryZoom($event)">
                <span v-for="segment in week.segments" :key="segment.key" class="history-bar-segment" :class="{ 'top-five-spec': segment.isTopFive }" :style="{ width: `${segment.share}%`, background: segment.color }" :aria-label="`${segment.spec} ${segment.className}: ${segment.share.toFixed(1)}%`" role="img" tabindex="0" @mouseenter="zoomHistoryAtPointer($event); showHistoryTooltip($event, segment)" @mousemove="moveHistoryTooltip" @mouseleave="historyTooltip = null" @focus="zoomHistoryAtPointer($event); showHistoryTooltip($event, segment)" @blur="historyTooltip = null"><img :src="specIcon(segment.spec, segment.className)" alt="" loading="lazy" @error="handleIconError($event, segment.className)"/><small>{{ segment.share.toFixed(1) }}%</small></span>
              </span>
              <span class="history-scroll-hint history-scroll-hint-left" aria-hidden="true">‹ Scroll</span><span class="history-scroll-hint history-scroll-hint-right" aria-hidden="true">Scroll ›</span>
              </span>
              <span class="history-bar-stats"><b>{{ week.runs.toLocaleString() }}</b><i>/</i>{{ week.averageLevel.toFixed(1) }}<i>/</i><strong>+{{ week.highestKey }}</strong><i>/</i><em>{{ week.diversity.toFixed(2) }}</em></span>
            </button>
          </div>
        </section>
      </template>
      <div v-if="historyTooltip" class="history-spec-tooltip" :style="{ left: `${historyTooltip.left}px`, top: `${historyTooltip.top}px` }" role="status">
        <img :src="specIcon(historyTooltip.spec, historyTooltip.className)" alt="" @error="handleIconError($event, historyTooltip.className)" />
        <span><b>{{ historyTooltip.spec }}</b><small>{{ historyTooltip.className }}</small><small v-if="historyTooltip.detail">{{ historyTooltip.detail }}</small></span>
        <strong>{{ historyTooltip.share.toFixed(1) }}%</strong>
      </div>
    </main>

    <main v-else-if="currentPage === 'methodology'" class="methodology-main">
      <div class="kicker"><span class="status-dot"></span> TRANSPARENT BY DESIGN</div>
      <h1>How we calculate the <span>meta</span></h1>
      <p class="methodology-lead">This page explains what the numbers mean, how compositions are ranked, and what the available run data can and cannot tell us.</p>
      <section class="methodology-card"><span class="eyebrow">01 / DATA</span><h2>Runs in the sample</h2><p>We analyze the ranked Mythic+ runs imported from Raider.IO. Use the region, date window, minimum key and sample-size filters to change the sample. The sample-size selector keeps the highest Raider.IO scores from the combined set of selected regions after the date and minimum-key filters. “All available” includes every imported run matching those filters.</p><p>“All imported dates” means the runs currently stored in this site; it is not a complete archive of every run ever completed. The 7-day and 30-day options are rolling windows and do not follow the weekly World of Warcraft reset.</p></section>
      <section class="methodology-card"><span class="eyebrow">02 / POPULARITY</span><h2>Composition counts and share</h2><p>A composition is the five specializations in a run, with their roles kept in tank, healer and damage order. Its <b>runs</b> value is how many sampled runs used that exact five-spec combination. <b>Share</b> is that count divided by all runs in the current sample.</p><p>The Meta score gives <b>40% to popularity</b>, <b>40% to average-key difficulty</b> and <b>20% to highest-key difficulty</b>. Popularity uses a logarithmic scale relative to the most-played composition, so more runs help while the benefit gradually tapers off. We mark a composition “established” when it has at least <code>max(50, 2.5% of the current sample)</code> runs. This is an evidence label, not a ranking cutoff; low-sample comps remain visible.</p></section>
      <section class="methodology-card"><span class="eyebrow">03 / PERFORMANCE</span><h2>How the Meta score works</h2><p><b>Average key</b> is the mean key level of the composition’s sampled runs; <b>highest key</b> is its top observed level. Both performance signals are pulled toward the weighted average key of the whole sample when a composition has few runs:</p><div class="formula">adjusted key = sample average + (composition key − sample average) × n / (n + 50)</div><p>We convert each adjusted key to a difficulty score relative to the highest adjusted value in the sample. Each key level is treated as roughly 15% harder:</p><div class="formula">difficulty score = 1.15<sup>(adjusted key − highest adjusted key)</sup> × 100</div><p>The final score is <code>40% × popularity + 40% × average-key difficulty + 20% × highest-key difficulty</code>. The sample adjustment and popularity weighting make an unusually high key from a small sample less likely to outrank a widely played, consistently high-performing composition.</p><p>This is a transparent ranking heuristic, not a statistical proof of a comp’s strength. The 15% difficulty step is an approximation, and the score does not control for player skill, repeated groups, route choices or selection bias; it does not prove a composition causes higher keys.</p></section>
      <section class="methodology-card"><span class="eyebrow">04 / SPECIALIZATIONS</span><h2>Pick rates and diversity</h2><p>Pick rate is the share of all five-player slots occupied by a specialization in the selected runs. It is not the percentage of groups that contain that spec. Class shares use the same player-slot basis, and each class card shows how its appearances split between its specializations.</p><p>The diversity chart uses the Gini coefficient of specialization appearances at each key level. A value nearer 0 means appearances are more evenly spread; a value nearer 1 means they are more concentrated in fewer specializations. It describes this sample, not the strength of every spec.</p></section>
      <section class="methodology-card"><span class="eyebrow">05 / DUNGEONS & LIMITS</span><h2>What to keep in mind</h2><p>The dungeon table summarizes the selected sample’s run counts, key levels and available clear times. Raider.IO’s ranked-run data represents successful high-ranking runs, not every group or failed attempt. The same characters and teams can appear more than once.</p><p>Use popularity, average key and adjusted result together. A rare composition can have a high average from very few runs, while a popular composition can reflect broader adoption. None of these statistics alone defines a definitive “best” team.</p></section>
      <button class="back-to-dashboard" @click="navigatePage('dashboard')">← Back to dashboard</button>
    </main>
    <main v-else id="top">
      <section class="intro">
        <div class="intro-copy">
          <div class="kicker"><span class="status-dot"></span> CURRENT WEEKLY META <span class="kicker-season">{{ data?.season || 'CURRENT SEASON' }}</span></div>
          <h1>What’s in the <span>meta?</span></h1>
          <p>The current weekly reset period, ranked and compared across the imported regions.</p>
        </div>
        <div class="filters">
          <label class="filter-control" for="region-select">Region
            <select id="region-select" v-model="region">
              <option v-for="option in regions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
        </div>
      </section>

      <div v-if="error" class="notice error"><b>Couldn’t load the meta data</b><span>{{ error }}</span><small>Check the MySQL connection and the stored weekly data. Manual imports are run from the command line with <code>npm run sync:weekly</code>.</small></div>
      <div v-else-if="loading && !data" class="notice">Loading the regional meta sample…</div>
      <template v-else-if="data">
        <div class="summary-grid dashboard-summary" id="overview">
          <article class="summary-card featured"><span class="summary-label">WEEKLY PERIOD</span><div class="summary-value">{{ data.periodId }}</div><div class="summary-foot period-day-list"><span>{{ data.season }}</span><span v-for="window in regionWindowsByProgress" :key="window.region" class="period-day" :data-tooltip="regionPeriodTitle(window)" :aria-label="regionPeriodTitle(window)" tabindex="0">{{ regionPeriodLabel(window) }}</span></div></article>
          <article class="summary-card"><span class="summary-label">AVERAGE KEY</span><div class="summary-value">{{ data.averageLevel.toFixed(1) }}</div><div class="summary-foot">Top-run sample · up to 2,000 per region</div></article>
          <article class="summary-card"><span class="summary-label">HIGHEST KEY</span><div class="summary-value">+{{ data.highestKey }}</div><div class="summary-foot">Current period</div></article>
        </div>

        <section class="dashboard-highlights">
          <article class="panel top-meta-panel">
            <div class="panel-heading"><div><span class="eyebrow">CURRENT META</span><h2>Top 3 compositions</h2><p>Popular teams with strong results in the current weekly period.</p></div></div>
            <div class="top-meta-list">
              <div v-for="comp in data.topComps.slice(0, 3)" :key="comp.composition.map((x) => x.spec + x.class).join('|')" class="top-meta-row">
                <b class="top-meta-rank">{{ String(comp.metaRank).padStart(2, '0') }}</b>
                <div class="top-meta-content"><div class="party-composition"><div v-for="(player, index) in comp.composition" :key="index" class="spec-avatar" :style="classStyle(player.class)"><img :src="specIcon(player.spec, player.class)" alt="" loading="lazy" @error="handleIconError($event, player.class)"/><span>{{ player.spec }}</span></div></div><small>{{ comp.count.toLocaleString() }} runs | {{ comp.share.toFixed(1) }}% share | {{ comp.averageLevel.toFixed(1) }} avg key</small></div>
                <strong class="top-meta-score">{{ comp.metaScore.toFixed(1) }}</strong>
              </div>
            </div>
            <button class="dashboard-details-link" @click="openCurrentPeriodDetails">View all compositions in period {{ data.periodId }} ?</button>
          </article>
          <article v-if="data.fastestHighestRun" class="panel fastest-run-panel">
            <div class="panel-heading"><div><span class="eyebrow">HIGHEST KEY - FASTEST CLEAR</span><h2>+{{ data.fastestHighestRun.level }} <small>{{ formatRunDuration(data.fastestHighestRun.durationMs) }}</small></h2><p>{{ data.fastestHighestRun.dungeon }} | {{ data.fastestHighestRun.region.toUpperCase() }}</p></div></div>
            <div class="party-composition fastest-run-party"><div v-for="(player, index) in data.fastestHighestRun.composition" :key="index" class="spec-avatar" :style="classStyle(player.class)"><img :src="specIcon(player.spec, player.class)" alt="" loading="lazy" @error="handleIconError($event, player.class)"/><span>{{ player.spec }}</span></div></div>
            <small>Selected by timer margin: {{ data.fastestHighestRun.timeRemainingPct.toFixed(1) }}% left ({{ formatTimeDelta(data.fastestHighestRun.timeRemainingMs) }} of {{ formatRunDuration(data.fastestHighestRun.timeLimitMs) }}).</small>
          </article>
        </section>

        <section class="analysis-grid" id="specializations">
          <article class="panel spec-panel">
            <div class="panel-heading"><div><span class="eyebrow">PICK RATE</span><h2>Specialization representation</h2><p>Specs are grouped by role and ordered by representation. Percentages show each spec's share within its role.</p></div></div>
            <div class="role-spec-chart">
              <div v-for="group in dashboardRoleRepresentation" :key="group.role" class="role-spec-row">
                <div class="role-spec-heading"><b>{{ group.role }}</b><small>{{ group.pickRate.toFixed(1) }}% of all player slots</small></div>
                <div class="role-candle-chart">
                  <div v-for="segment in group.segments" :key="segment.spec + segment.className" class="role-candle-row" :aria-label="`${segment.spec} ${segment.className}: ${segment.share.toFixed(1)}% overall, ${segment.roleShare.toFixed(1)}% of ${group.role}`" tabindex="0" @mouseenter="showHistoryTooltip($event, segment)" @mousemove="moveHistoryTooltip" @mouseleave="historyTooltip = null" @focus="showHistoryTooltip($event, segment)" @blur="historyTooltip = null">
                    <img :src="specIcon(segment.spec, segment.className)" :alt="`${segment.spec} icon`" loading="lazy" @error="handleIconError($event, segment.className)"/><span class="role-candle-track"><i :style="{ '--spec-color': segment.color, width: `${segment.roleShare}%` }"><b>{{ segment.spec }}</b></i></span><strong>{{ segment.share.toFixed(1) }}%</strong>
                  </div>
                </div>
              </div>
            </div></article>

          <article class="panel diversity-panel">
            <div class="panel-heading"><div><span class="eyebrow">SPECIALIZATION DIVERSITY</span><h2>Meta concentration by key</h2><p>Gini index for spec appearances. Higher means picks are concentrated in fewer specs.</p></div></div>
            <div v-if="diversityPoints.length" class="chart-wrap">
              <svg class="diversity-chart" viewBox="0 0 800 260" role="img" aria-label="Specialization diversity Gini coefficient by key level">
                <g class="chart-grid"><line v-for="y in [46, 101, 157, 212]" :key="y" x1="48" :y1="y" x2="752" :y2="y" /></g>
                <text v-for="(label, index) in ['1.0', '0.67', '0.33', '0']" :key="label" x="8" :y="[50,105,161,216][index]">{{ label }}</text>
                <polyline :points="diversityLine" fill="none" stroke="#80b918" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                <g v-for="point in diversityPoints" :key="point.level" class="chart-point"><circle :cx="point.x" :cy="point.y" r="5"><title>+{{ point.level }} · Gini {{ point.gini.toFixed(2) }} · {{ point.runs }} runs</title></circle><text :x="point.x" :y="point.labelY" text-anchor="middle">+{{ point.level }}</text></g>
              </svg>
            </div>
            <div v-else class="empty-cell">Import runs to build the diversity chart.</div>
            <div class="gini-legend"><span><i class="low"></i>More evenly distributed</span><span><i class="high"></i>More concentrated</span></div>
          </article>
        </section>

        <section class="panel class-panel">
          <div class="panel-heading"><div><span class="eyebrow">CLASS BREAKDOWN</span><h2>Which classes make the top runs?</h2><p>Class slices show their share of all player slots. Hover or focus a slice to see its specialization breakdown.</p></div></div>
          <div v-if="classPieSegments.length" class="class-pie-layout">
            <div class="class-pie-wrap">
              <svg class="class-pie-chart" viewBox="0 0 240 240" role="group" aria-label="Player slot share by class">
                <circle class="class-pie-track" cx="120" cy="120" r="78" />
                <circle v-for="segment in classPieSegments" :key="segment.class" class="class-pie-segment" :class="{ active: displayedClass?.class === segment.class }" cx="120" cy="120" r="78" :stroke="segment.color" :stroke-dasharray="`${segment.length} ${classPieCircumference}`" :stroke-dashoffset="-segment.offset" :aria-label="`${segment.class}: ${segment.share.toFixed(1)}% of player slots`" role="button" tabindex="0" @mouseenter="hoveredClass = segment.class" @mouseleave="hoveredClass = null" @focus="hoveredClass = segment.class" @blur="hoveredClass = null" @click="selectedClass = segment.class"><title>{{ segment.class }}: {{ segment.share.toFixed(1) }}% of player slots</title></circle>
                <text v-for="segment in classPieSegments.filter((item) => item.length >= 38)" :key="`${segment.class}-share`" class="class-pie-label" :x="segment.labelX" :y="segment.labelY" :transform="`rotate(90 ${segment.labelX} ${segment.labelY})`" text-anchor="middle" dominant-baseline="central">{{ segment.share.toFixed(1) }}%</text>
              </svg>
              <div v-if="displayedClass" class="class-pie-center"><b>{{ displayedClass.class }}</b><strong>{{ displayedClass.pickRate.toFixed(1) }}%</strong><small>of player slots</small></div>
            </div>
            <article v-if="displayedClass" class="class-detail-card" :style="classStyle(displayedClass.class)">
              <header><img :src="classIcon(displayedClass.class)" :alt="`${displayedClass.class} icon`" @error="handleIconError($event, displayedClass.class)"/><div><span class="eyebrow">SPECIALIZATIONS</span><h3>{{ displayedClass.class }}</h3></div><strong>{{ displayedClass.pickRate.toFixed(1) }}%</strong></header>
              <div class="class-detail-specs"><div v-for="spec in displayedClass.specs" :key="spec.spec" class="class-detail-spec"><img :src="specIcon(spec.spec, displayedClass.class)" :alt="`${spec.spec} icon`" loading="lazy" @error="handleIconError($event, displayedClass.class)"/><b>{{ spec.spec }}</b><span class="class-detail-track"><i :style="{ width: `${spec.withinClass}%` }"></i></span><strong>{{ spec.withinClass.toFixed(1) }}%</strong></div></div>
            </article>
          </div>
          <div v-else class="empty-cell">No class representation data is available.</div>
        </section>

        <section class="panel dungeon-panel" id="dungeons">
          <div class="panel-heading"><div><span class="eyebrow">DUNGEON SNAPSHOT</span><h2>Dungeon performance</h2><p>Easiest and hardest combine average key level and timer margin. Fastest has the greatest average percentage of its timer left, adjusted for different dungeon time limits.</p></div></div>
          <div class="table-scroll"><table class="dungeon-table"><thead><tr><th>Dungeon</th><th>Runs</th><th>Share</th><th>Average key</th><th>Highest key</th><th>Time limit</th><th>Avg. clear time</th><th>Avg. time left</th><th>Most time left</th></tr></thead><tbody><tr v-for="dungeon in data.dungeons" :key="dungeon.dungeon" :class="{ 'dungeon-easiest-row': easiestDashboardDungeon?.dungeon === dungeon.dungeon, 'dungeon-hardest-row': hardestDashboardDungeon?.dungeon === dungeon.dungeon, 'dungeon-fastest-row': fastestDashboardDungeon?.dungeon === dungeon.dungeon }"><td class="dungeon-cell"><b>{{ dungeon.dungeon }}</b><span class="dungeon-result-badges"><small v-if="easiestDashboardDungeon?.dungeon === dungeon.dungeon" class="dashboard-dungeon-badge easiest-badge">Easiest</small><small v-if="hardestDashboardDungeon?.dungeon === dungeon.dungeon" class="dashboard-dungeon-badge hardest-badge">Hardest</small><small v-if="fastestDashboardDungeon?.dungeon === dungeon.dungeon" class="dashboard-dungeon-badge fastest-badge">Fastest (timer adjusted)</small></span></td><td>{{ dungeon.runs }}</td><td>{{ (dungeon.runs / data.sampleSize * 100).toFixed(1) }}%</td><td>{{ dungeon.averageLevel.toFixed(1) }}</td><td><span class="key-pill">+{{ dungeon.maxLevel }}</span></td><td>{{ dungeon.timeLimitMs ? formatRunDuration(dungeon.timeLimitMs) : 'N/A' }}</td><td>{{ dungeon.averageClearTimeMs ? formatRunDuration(dungeon.averageClearTimeMs) : 'N/A' }}</td><td>{{ formatTimeDelta(dungeon.averageTimeRemainingMs) }}</td><td><b>{{ formatTimeDelta(dungeon.maxTimeRemainingMs) }}</b><small v-if="dungeon.fastestRunLevel" class="table-subtext">on +{{ dungeon.fastestRunLevel }}</small></td></tr></tbody></table></div>
        </section>

        <p class="method-note"><b>How to read this:</b> Meta score weights logarithmic popularity at 40%, average-key difficulty at 40% and highest-key difficulty at 20%. Key performance is pulled toward the sample average by n / (n + 50), and each key level is treated as roughly 15% harder. Low-sample comps remain visible and are marked. This is a ranking heuristic, not proof that a comp causes higher keys. The dashboard uses only the current Blizzard weekly period and stores up to 2,000 top-scored runs per region. It represents ranked runs, not every attempt; groups can appear more than once.</p>
        <div v-if="historyTooltip" class="history-spec-tooltip" :style="{ left: `${historyTooltip.left}px`, top: `${historyTooltip.top}px` }" role="status"><img :src="specIcon(historyTooltip.spec, historyTooltip.className)" alt="" @error="handleIconError($event, historyTooltip.className)"/><span><b>{{ historyTooltip.spec }}</b><small>{{ historyTooltip.className }}</small><small v-if="historyTooltip.detail">{{ historyTooltip.detail }}</small></span><strong>{{ historyTooltip.share.toFixed(1) }}%</strong></div>
      </template>
    </main>

    <footer class="site-footer"><a class="brand" href="/" aria-label="MythicPlusMeta home" @click.prevent="navigatePage('dashboard')"><span class="brand-icon" aria-hidden="true">M<sup>+</sup>M</span><span class="brand-name">mythicplus<span>meta</span></span></a><a class="methodology-footer-link" href="/methodology" @click.prevent="navigatePage('methodology')">How we calculate the meta</a><span>Mythic+ data by <a href="https://raider.io" target="_blank" rel="noreferrer">Raider.IO</a></span><span>Local guild meta explorer</span></footer>
  </div>
</template>
