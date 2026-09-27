import { createHash } from 'node:crypto';

export const RESEARCH_CORPUS = 'learning.space.research.v1';
export const SEED_VERSION = '2026-09-27.1';
export const REVIEW_DATE = '2026-09-27';
export type RelationType = 'prerequisite' | 'supports' | 'explains' | 'related';
export type ResearchSource = { id: string; url: string; title: string; publisher: string; retrievedAt: string; reviewedAt: string };
export type ResearchConcept = { id: string; cluster: string; title: string; claim: string };
export type ResearchRelation = { id: string; from: string; to: string; type: RelationType };
export type ResearchSupport = { targetType: 'concept' | 'relation'; targetId: string; sourceId: string; locator: string; summary: string };
export type ResearchGraph = { sources: ResearchSource[]; concepts: ResearchConcept[]; relations: ResearchRelation[]; supports: ResearchSupport[] };

const date = REVIEW_DATE;
const sourceRows: [string, string, string][] = [
  ['solar-system', 'https://science.nasa.gov/solar-system/solar-system-facts/', 'Solar System Facts'],
  ['planets', 'https://science.nasa.gov/solar-system/planets/', 'About the Planets'],
  ['sun', 'https://science.nasa.gov/sun/facts/', 'Sun: Facts'],
  ['mercury', 'https://science.nasa.gov/mercury/facts/', 'Mercury: Facts'],
  ['venus', 'https://science.nasa.gov/venus/venus-facts/', 'Venus: Facts'],
  ['moon', 'https://science.nasa.gov/moon/moon-phases/', 'Moon Phases'],
  ['moon-facts', 'https://science.nasa.gov/moon/facts/', 'Moon Facts'],
  ['eclipses', 'https://science.nasa.gov/moon/eclipses/', 'Eclipses and the Moon'],
  ['tides', 'https://science.nasa.gov/moon/tides/', 'Tides'],
  ['asteroids', 'https://science.nasa.gov/solar-system/asteroids/facts/', 'Asteroid Facts'],
  ['comets', 'https://science.nasa.gov/solar-system/comets/facts/', 'Comet Facts'],
  ['kuiper', 'https://science.nasa.gov/solar-system/kuiper-belt/facts/', 'Kuiper Belt Facts'],
  ['oort', 'https://science.nasa.gov/solar-system/oort-cloud/facts/', 'Oort Cloud Facts'],
  ['dwarfs', 'https://science.nasa.gov/dwarf-planets/', 'Pluto & Dwarf Planets'],
  ['pluto', 'https://science.nasa.gov/dwarf-planets/pluto/facts/', 'Pluto: Facts'],
  ['jupiter', 'https://science.nasa.gov/jupiter/jupiter-facts/', 'Jupiter Facts'],
];
export const seedSources: ResearchSource[] = sourceRows.map(([id, url, title]) => ({ id, url, title, publisher: 'NASA Science', retrievedAt: date, reviewedAt: date }));

// Each row is a short paraphrase of the identified NASA section, never a generated quotation.
// Prerequisites are pedagogical dependencies. Their support points to the target's source section.
type Row = [string, string, string, string, string, string, string?];
const rows: Row[] = [
  ['solar-system','solar-system','Solar System','The Sun, planets, dwarf planets, moons, asteroids, and comets form our solar system.','solar-system','Introduction'],
  ['sun-star','sun','The Sun is a star','The Sun is a star of hydrogen and helium held together by gravity.','sun','Structure','solar-system'],
  ['sun-core','sun','Solar core','The core is the hottest interior region of the Sun.','sun','Structure','sun-star'],
  ['solar-fusion','sun','Solar fusion','Hydrogen fuses into helium in the Sun’s core, powering its heat and light.','sun','Structure','sun-core'],
  ['solar-radiation','sun','Solar energy transport','Energy made in the core travels outward through radiation and convection zones.','sun','Structure','solar-fusion'],
  ['photosphere','sun','Photosphere','The photosphere is the Sun’s visible light emitting layer.','sun','Surface','solar-radiation'],
  ['solar-corona','sun','Solar corona','The corona is the Sun’s outer atmosphere.','sun','Atmosphere','photosphere'],
  ['solar-wind','sun','Solar wind','Material escaping the corona forms the solar wind.','sun','Structure','solar-corona'],
  ['heliosphere','sun','Heliosphere','The solar wind creates a magnetic bubble called the heliosphere.','sun','Structure','solar-wind'],
  ['eight-planets','planets','Eight planets','Mercury through Neptune are the eight planets of the solar system.','planets','Introduction','solar-system'],
  ['planet-orbits','solar-system','Planets orbit the Sun','The planets belong to a system centered on the Sun.','solar-system','Introduction','eight-planets'],
  ['inner-planets','planets','Inner planets','Mercury, Venus, Earth, and Mars are the four inner planets.','planets','Introduction','eight-planets'],
  ['outer-planets','planets','Outer planets','Jupiter, Saturn, Uranus, and Neptune follow the inner planets.','planets','Introduction','eight-planets'],
  ['mercury-nearest','mercury','Mercury nearest the Sun','Mercury is the nearest planet to the Sun.','mercury','Introduction','inner-planets'],
  ['mercury-smallest','mercury','Mercury smallest planet','Mercury is the smallest of the eight planets.','mercury','Introduction','mercury-nearest'],
  ['mercury-year','mercury','Mercury short year','Mercury orbits the Sun in about 88 Earth days.','mercury','Orbit and Rotation','planet-orbits'],
  ['mercury-temperature','mercury','Mercury temperature range','Mercury has very hot days and very cold nights.','mercury','Introduction','mercury-nearest'],
  ['mercury-no-moons','mercury','Mercury has no moons','Mercury has no natural moons.','mercury','Moons','mercury-smallest'],
  ['venus-hottest','venus','Venus hottest planet','Venus has the hottest planetary surface in the solar system.','venus','Introduction','inner-planets'],
  ['venus-atmosphere','venus','Venus dense atmosphere','Venus has a dense atmosphere that traps heat.','venus','Introduction','venus-hottest'],
  ['venus-radar','venus','Venus radar mapping','NASA’s Magellan spacecraft mapped Venus’s surface with radar.','venus','Introduction','venus-atmosphere'],
  ['earth-life','solar-system','Known life on Earth','Earth is the only world where life is currently known.','solar-system','Potential for Life','inner-planets'],
  ['moon-satellite','moon-facts','Earth’s Moon','The Moon is Earth’s natural satellite.','moon-facts','Introduction','earth-life'],
  ['earth-moon-positions','moon','Sun Earth Moon positions','The relative positions of the Sun, Earth, and Moon change as the Moon orbits.','moon','Introduction','moon-satellite'],
  ['moon-orbit','moon','Moon orbit','The Moon orbits Earth and changes its position relative to the Sun.','moon','Introduction','earth-moon-positions'],
  ['sun-light','moon','Sunlight reaches the Moon','The Sun supplies light to the Moon.','moon','Introduction','sun-star'],
  ['moon-reflection','moon','Moon reflects sunlight','The visible Moon is illuminated by sunlight.','moon','Introduction','sun-light'],
  ['half-lit','moon','Moon’s sunlit half','Sunlight illuminates half of the Moon except during an eclipse.','moon','Introduction','moon-reflection'],
  ['visible-half','moon','Changing Moon view','An observer on Earth sees different portions of the Moon’s sunlit half.','moon','Introduction','half-lit'],
  ['new-full','moon','New and full Moon','At new and full Moon, Earth sees very different amounts of the illuminated half.','moon','The Moon’s Phases','visible-half'],
  ['wax-wane','moon','Waxing and waning','Waxing grows the visible lit portion; waning shrinks it.','moon','The Moon’s Phases','visible-half'],
  ['not-earth-shadow','moon','Phases are not Earth’s shadow','Ordinary Moon phases differ from lunar eclipses caused by Earth’s shadow.','moon','Introduction','visible-half'],
  ['moon-phases','moon','Moon phases','Moon phases are changing views of the Moon as it orbits Earth.','moon','Introduction','new-full'],
  ['new-moon','moon','New Moon','At new Moon, the Moon appears dark from Earth.','moon','The Moon’s Phases','new-full'],
  ['full-moon','moon','Full Moon','At full Moon, the Earth-facing side appears illuminated.','moon','The Moon’s Phases','new-full'],
  ['waxing','moon','Waxing Moon','Waxing describes an increasing visible illuminated portion.','moon','The Moon’s Phases','wax-wane'],
  ['waning','moon','Waning Moon','Waning describes a decreasing visible illuminated portion.','moon','The Moon’s Phases','wax-wane'],
  ['solar-eclipse','eclipses','Solar eclipse','A solar eclipse occurs when the Moon passes between Earth and the Sun.','eclipses','Solar Eclipses','new-moon'],
  ['lunar-eclipse','eclipses','Lunar eclipse','A lunar eclipse occurs when Earth’s shadow falls on the Moon.','eclipses','Lunar Eclipses','full-moon'],
  ['eclipse-alignment','eclipses','Eclipse alignment','Eclipses require the Sun, Earth, and Moon to align.','eclipses','Introduction','moon-orbit'],
  ['tides-gravity','tides','Tidal gravity','The Moon’s gravity contributes strongly to Earth’s ocean tides.','tides','Introduction','moon-satellite'],
  ['spring-tides','tides','Spring tides','Sun and Moon tidal effects combine around new and full Moon.','tides','Spring Tides','tides-gravity'],
  ['neap-tides','tides','Neap tides','Tidal ranges are smaller near quarter Moon phases.','tides','Neap Tides','tides-gravity'],
  ['asteroids','asteroids','Asteroids','Asteroids are small rocky remnants from solar system formation.','asteroids','Introduction','solar-system'],
  ['asteroid-belt','asteroids','Main asteroid belt','Most known asteroids orbit between Mars and Jupiter.','asteroids','Main Asteroid Belt','asteroids'],
  ['jupiter-gravity-belt','asteroids','Jupiter shaped asteroid belt','Jupiter’s gravity hindered planet formation in the asteroid belt.','asteroids','Main Asteroid Belt','asteroid-belt'],
  ['asteroid-collisions','asteroids','Asteroid collisions','Collisions fragmented bodies in the main asteroid belt.','asteroids','Main Asteroid Belt','jupiter-gravity-belt'],
  ['near-earth-asteroids','asteroids','Near Earth asteroids','Some asteroids approach Earth’s orbital neighborhood.','asteroids','Near-Earth Objects','asteroids'],
  ['comets','comets','Comets','Comets are icy bodies that release gas and dust when warmed.','comets','Introduction','solar-system'],
  ['comet-nucleus','comets','Comet nucleus','A comet’s nucleus contains ice, dust, and rock.','comets','Structure','comets'],
  ['comet-coma','comets','Comet coma','Sunlight warms a comet nucleus and produces a cloud around it.','comets','Structure','comet-nucleus'],
  ['comet-tail','comets','Comet tails','Solar radiation and solar wind push material away from a comet.','comets','Structure','comet-coma'],
  ['kuiper-belt','kuiper','Kuiper Belt','The Kuiper Belt is a region of icy bodies beyond Neptune.','kuiper','Introduction','outer-planets'],
  ['kuiper-remnants','kuiper','Kuiper Belt remnants','Kuiper Belt objects preserve material from early solar system history.','kuiper','Introduction','kuiper-belt'],
  ['kuiper-comets','kuiper','Kuiper Belt comet source','Some comets originate in the Kuiper Belt.','kuiper','Introduction','kuiper-belt'],
  ['oort-cloud','oort','Oort Cloud','The Oort Cloud is a proposed distant spherical shell of icy bodies.','oort','Introduction','solar-system'],
  ['oort-inferred','oort','Oort Cloud inference','The Oort Cloud is inferred from models and comet observations, not directly imaged.','oort','Introduction','oort-cloud'],
  ['oort-comets','oort','Oort Cloud comet source','Some comets are thought to originate in the distant Oort Cloud.','oort','Introduction','oort-inferred'],
  ['dwarf-planets','dwarfs','Dwarf planets','Five dwarf planets are officially recognized in the solar system.','dwarfs','Introduction','solar-system'],
  ['ceres','dwarfs','Ceres','Ceres is the only recognized dwarf planet in the inner solar system.','dwarfs','Ceres','dwarf-planets'],
  ['ceres-belt','dwarfs','Ceres in the belt','Ceres is the largest body in the main asteroid belt.','dwarfs','Ceres','ceres'],
  ['pluto','pluto','Pluto','Pluto is a dwarf planet in the trans-Neptunian region.','pluto','Introduction','dwarf-planets'],
  ['pluto-orbit','pluto','Pluto orbital neighborhood','Pluto has not cleared its orbital neighborhood of other bodies.','pluto','Introduction','pluto'],
  ['pluto-charon','solar-system','Pluto and Charon','Charon is a large moon that makes Pluto wobble.','solar-system','Moons','pluto'],
  ['jupiter','jupiter','Jupiter','Jupiter is the fifth planet from the Sun.','jupiter','Introduction','outer-planets'],
  ['jupiter-ganymede','jupiter','Ganymede','Ganymede is the solar system’s largest moon.','jupiter','Moons','jupiter'],
  ['jupiter-core','jupiter','Jupiter’s core','Juno observations suggest Jupiter’s core is larger and less solid than once expected.','jupiter','Structure','jupiter'],
  ['saturn','planets','Saturn','Saturn is one of the four outer planets.','planets','Introduction','outer-planets'],
  ['uranus','planets','Uranus','Uranus is one of the four outer planets.','planets','Introduction','outer-planets'],
  ['neptune','planets','Neptune','Neptune is the outermost of the eight planets.','planets','Introduction','outer-planets'],
];

export const seedGraph: ResearchGraph = (() => {
  const concepts = rows.map(([id, cluster, title, claim]) => ({ id, cluster, title, claim }));
  const prerequisiteTargets = new Set([
    'sun-core','solar-fusion','solar-radiation','photosphere','solar-corona','solar-wind','heliosphere',
    'planet-orbits','mercury-year','moon-orbit','sun-light','moon-reflection','half-lit','visible-half',
    'new-full','wax-wane','moon-phases','solar-eclipse','lunar-eclipse','eclipse-alignment',
    'tides-gravity','spring-tides','neap-tides','comet-coma','comet-tail','kuiper-comets','oort-comets',
  ]);
  const relations: ResearchRelation[] = rows.flatMap(([id,,,,,, parent]) => parent ? [{ id: `${parent}-to-${id}`, from: parent, to: id, type: prerequisiteTargets.has(id) ? 'prerequisite' : 'related' }] : []);
  const supports: ResearchSupport[] = rows.flatMap(([id,,,claim,sourceId,locator,parent]) => [
    { targetType: 'concept' as const, targetId: id, sourceId, locator, summary: claim },
    ...(parent ? [{ targetType: 'relation' as const, targetId: `${parent}-to-${id}`, sourceId, locator, summary: prerequisiteTargets.has(id) ? `Understanding ${titleFor(id)} builds on ${titleFor(parent)}.` : `${titleFor(id)} is a related part of the ${titleFor(parent)} topic.` }] : []),
  ]);
  const crossTopic: [ResearchRelation, ResearchSupport][] = [
    [{ id: 'solar-wind-explains-comet-tail', from: 'solar-wind', to: 'comet-tail', type: 'explains' }, { targetType: 'relation', targetId: 'solar-wind-explains-comet-tail', sourceId: 'comets', locator: 'Structure', summary: 'Solar wind helps push a comet tail away from the Sun.' }],
    [{ id: 'venus-atmosphere-explains-venus-hottest', from: 'venus-atmosphere', to: 'venus-hottest', type: 'explains' }, { targetType: 'relation', targetId: 'venus-atmosphere-explains-venus-hottest', sourceId: 'venus', locator: 'Introduction', summary: 'The dense Venus atmosphere traps heat and helps make it the hottest planet.' }],
    [{ id: 'jupiter-gravity-belt-explains-asteroid-belt', from: 'jupiter-gravity-belt', to: 'asteroid-belt', type: 'explains' }, { targetType: 'relation', targetId: 'jupiter-gravity-belt-explains-asteroid-belt', sourceId: 'asteroids', locator: 'Main Asteroid Belt', summary: 'Jupiter’s gravity interrupted planet formation in the asteroid belt.' }],
    [{ id: 'ceres-belt-related-asteroid-belt', from: 'ceres-belt', to: 'asteroid-belt', type: 'related' }, { targetType: 'relation', targetId: 'ceres-belt-related-asteroid-belt', sourceId: 'dwarfs', locator: 'Ceres', summary: 'Ceres is located in the main asteroid belt.' }],
    [{ id: 'kuiper-comets-supports-comets', from: 'kuiper-comets', to: 'comets', type: 'supports' }, { targetType: 'relation', targetId: 'kuiper-comets-supports-comets', sourceId: 'kuiper', locator: 'Introduction', summary: 'Kuiper Belt objects are a source of some comets.' }],
  ];
  for (const [relation, support] of crossTopic) { relations.push(relation); supports.push(support); }
  return { sources: seedSources, concepts, relations, supports };
})();
function titleFor(id: string) { return rows.find(row => row[0] === id)?.[2] ?? id; }

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const graphHash = (graph: ResearchGraph) => createHash('sha256').update(stable(graph)).digest('hex');
const ident = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export function graphIssues(g: ResearchGraph): string[] {
  if (!g || !['sources','concepts','relations','supports'].every(k => Array.isArray((g as any)[k]))) return ['invalid_graph_shape'];
  const issues: string[] = [];
  const ids = (name: keyof ResearchGraph) => { const list = g[name] as { id?: string }[]; const seen = new Set<string>(); for (const row of list) { if (!row || !ident.test(row.id ?? '')) issues.push(`invalid_${name}_id`); if (seen.has(row?.id ?? '')) issues.push(`duplicate_${name}_id:${row?.id}`); seen.add(row?.id ?? ''); } return seen; };
  const sources = ids('sources'), concepts = ids('concepts'), relations = ids('relations');
  const urls = new Set<string>();
  for (const s of g.sources) { const url = typeof s?.url === 'string' ? s.url.replace(/\/$/, '') : ''; if (url && urls.has(url)) issues.push(`duplicate_source_url:${url}`); urls.add(url); }
  for (const s of g.sources) if (!s || !/^https:\/\//.test(s.url) || !s.title?.trim() || !s.publisher?.trim() || !validDate(s.retrievedAt) || !validDate(s.reviewedAt)) issues.push(`invalid_source:${s?.id}`);
  for (const c of g.concepts) if (!c || !ident.test(c.cluster ?? '') || !c.title?.trim() || !c.claim?.trim()) issues.push(`invalid_concept:${c?.id}`);
  for (const r of g.relations) if (!r || !concepts.has(r.from) || !concepts.has(r.to) || r.from === r.to || !['prerequisite','supports','explains','related'].includes(r.type)) issues.push(`invalid_relation:${r?.id}`);
  const supportKeys = new Set<string>();
  for (const s of g.supports) {
    const key = `${s?.targetType}:${s?.targetId}:${s?.sourceId}`;
    if (supportKeys.has(key)) issues.push(`duplicate_support:${key}`);
    supportKeys.add(key);
    if (!s || !['concept','relation'].includes(s.targetType) || !(s.targetType === 'concept' ? concepts : relations).has(s.targetId) || !sources.has(s.sourceId) || !s.locator?.trim() || !s.summary?.trim()) issues.push(`invalid_support:${key}`);
  }
  for (const c of g.concepts) if (!g.supports.some(s => s.targetType === 'concept' && s.targetId === c.id)) issues.push(`unsupported_concept:${c.id}`);
  for (const r of g.relations) if (!g.supports.some(s => s.targetType === 'relation' && s.targetId === r.id)) issues.push(`unsupported_relation:${r.id}`);
  const next = new Map<string, string[]>();
  for (const r of g.relations.filter(r => r.type === 'prerequisite')) next.set(r.from, [...(next.get(r.from) ?? []), r.to]);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) { issues.push(`prerequisite_cycle:${id}`); return; } if (visited.has(id)) return; visiting.add(id); for (const to of next.get(id) ?? []) visit(to); visiting.delete(id); visited.add(id); };
  for (const id of concepts) visit(id);
  return [...new Set(issues)];
}

export function mergeGraph(base: ResearchGraph, addition: ResearchGraph): ResearchGraph {
  const merge = <T extends { id: string }>(a: T[], b: T[]) => {
    const map = new Map(a.map(row => [row.id, { ...row }]));
    for (const row of b) { const old = map.get(row.id); if (old && stable(old) !== stable(row)) throw new Error(`identifier_conflict:${row.id}`); map.set(row.id, { ...row }); }
    return [...map.values()].sort((x, y) => x.id.localeCompare(y.id));
  };
  const supports = base.supports.map(row => ({ ...row }));
  for (const row of addition.supports) if (!supports.some(s => stable(s) === stable(row))) supports.push({ ...row });
  return { sources: merge(base.sources, addition.sources), concepts: merge(base.concepts, addition.concepts), relations: merge(base.relations, addition.relations), supports: supports.sort((a,b) => stable(a).localeCompare(stable(b))) };
}

export function boundedWalk(graph: ResearchGraph, start: string, depth: number, limit: number) {
  if (!graph.concepts.some(c => c.id === start)) throw new Error('concept_not_found');
  if (!Number.isInteger(depth) || depth < 0 || depth > 4 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_bounds');
  const seen = new Set([start]); let frontier = [start];
  for (let d = 0; d < depth && seen.size < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const r of graph.relations.filter(r => r.from === id || r.to === id).sort((a,b) => a.id.localeCompare(b.id))) {
      const other = r.from === id ? r.to : r.from;
      if (!seen.has(other) && seen.size < limit) { seen.add(other); next.push(other); }
    }
    frontier = next;
  }
  return { concepts: graph.concepts.filter(c => seen.has(c.id)), relations: graph.relations.filter(r => seen.has(r.from) && seen.has(r.to)), truncated: seen.size === limit };
}
