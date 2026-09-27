import { createHash } from 'node:crypto';
import { graphHash, seedGraph, SEED_VERSION, type ResearchGraph } from './research-graph';
import type { Concept } from './curriculum';

export const ASSESSMENT_CORPUS = 'learning.space.assessment.v1';
export const ASSESSMENT_VERSION = '2026-09-27.1';
export const ASSESSMENT_REVIEWED_AT = '2026-09-27';
export const ASSESSMENT_GRAPH_HASH = graphHash(seedGraph);

type Card = Concept & { cluster: string; sourceId: string; locator: string; supportIds: string[]; sourceUrls: string[]; graphVersion: string; graphHash: string; cardVersion: string; reviewedAt: string; reviewStatus: 'reviewed' };
type Content = [string, string, string, string, string, string, string, string, string[][]];
// Curated against the identified NASA support in the immutable research seed.
// Rubric phrases are provisional hints for an independent human reviewer.
const content: Content[] = [
  ['solar-system','solar-system','Identify the major kinds of objects in our solar system.','The solar system includes the Sun and objects bound to it, including planets, dwarf planets, moons, asteroids and comets. These are different kinds of bodies, not all planets.','Name the central star and three different kinds of objects in the solar system.','Which star anchors our solar system, and what else belongs to it?','A friend lists only planets as the solar system. What have they omitted?','Introduction',[['sun'],['planet'],['moon','satellite'],['asteroid','comet','dwarf']]],
  ['sun-star','sun','Explain what the Sun is and what it is made of.','The Sun is a star held together by gravity. It is mostly hydrogen and helium, and its interior produces energy by fusion.','What kind of object is the Sun, and which two elements make up most of it?','Recall the Sun’s object class and its two main elements.','Why is the Sun called a star rather than a planet?','Structure',[['star'],['hydrogen'],['helium']]],
  ['eight-planets','planets','Identify the eight planets and their order from the Sun.','NASA lists eight planets in outward order: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus and Neptune. Pluto is classified as a dwarf planet.','Name the eight planets in order outward from the Sun.','Which planets come between Earth and Neptune, in order?','Start at Neptune and name the planets inward to Mercury.','Introduction',[['mercury'],['venus'],['earth'],['mars'],['jupiter'],['saturn'],['uranus'],['neptune']]],
  ['mercury-nearest','mercury','Locate Mercury relative to the Sun and the other planets.','Mercury is the planet nearest the Sun. It is also the smallest of the eight planets; proximity and size are separate facts.','Which planet is closest to the Sun, and is it the largest or smallest planet?','Recall Mercury’s position and relative size among the eight planets.','A learner says Venus is nearest the Sun. Correct the claim and give Mercury’s size distinction.','Introduction',[['mercury'],['nearest','closest','first'],['smallest']]],
  ['venus-hottest','venus','Explain why Venus has the hottest planetary surface.','Venus has a dense atmosphere that traps heat. Although Mercury is closer to the Sun, Venus has the hottest planetary surface.','Which planet has the hottest surface, and what atmospheric property helps explain it?','Why is Venus hotter at its surface than Mercury despite their order?','A friend picks Mercury as hottest because it is closest. Explain why Venus is hotter.','Introduction',[['venus'],['atmosphere'],['trap','greenhouse','retain','heat']]],
  ['new-moon','moon','Describe the Earth-facing view at new Moon.','At new Moon, the sunlit half mostly faces away from Earth. The Moon is still present and illuminated; its near side appears dark to us.','At new Moon, what does an observer on Earth see, and is the whole Moon unlit?','Recall why the new Moon appears dark from Earth.','A friend says the Moon disappears at new Moon. Explain the Sun–Moon–Earth viewing geometry.','The Moon’s Phases',[['earth'],['dark','not visible','unlit'],['sun','sunlit','illuminat']]],
  ['moon-satellite','moon-facts','Identify the Moon’s relationship to Earth.','The Moon is Earth’s natural satellite: a body that orbits Earth. It is distinct from Earth and reflects sunlight rather than producing its own visible light.','What is the Moon relative to Earth, and what motion makes it a satellite?','Recall which body the Moon orbits and its classification.','A learner calls the Moon a planet. Explain its relationship to Earth.','Introduction',[['moon'],['earth'],['satellite','orbit']]],
  ['solar-eclipse','eclipses','Explain the alignment that causes a solar eclipse.','A solar eclipse occurs when the Moon passes between Earth and the Sun, blocking sunlight for observers in part of Earth. This is different from a lunar eclipse.','Put the Sun, Moon and Earth in order for a solar eclipse and explain what is blocked.','Where is the Moon during a solar eclipse, and what does an Earth observer see?','A friend puts Earth between Sun and Moon for a solar eclipse. Correct the alignment.','Solar Eclipses',[['sun'],['moon'],['earth'],['between','block','shadow']]],
  ['tides-gravity','tides','Connect lunar gravity to Earth’s ocean tides.','The Moon’s gravity pulls on Earth’s oceans and is a major cause of tides. The Sun also contributes; tides are not caused by Moon light.','What force from the Moon contributes to ocean tides on Earth?','Recall the Moon’s role in Earth’s tides and name the force involved.','Why do tides relate to the Moon even when it is not visibly bright?','Introduction',[['moon'],['gravity','gravitational'],['ocean','water','tide']]],
  ['asteroids','asteroids','Describe what asteroids are and where many orbit.','Asteroids are small rocky remnants from solar system formation. Many known asteroids orbit the Sun in the main belt between Mars and Jupiter.','What are asteroids made of, and where is the main asteroid belt?','Recall the material and location of the main asteroid belt.','Contrast an asteroid with an icy comet and locate the asteroid belt.','Introduction',[['rock','rocky'],['mars'],['jupiter'],['belt','orbit']]],
  ['comets','comets','Explain a comet’s icy nucleus and activity near the Sun.','Comets contain ice, dust and rock. When sunlight warms a comet, gas and dust can escape and form a coma and tail.','What is a comet nucleus made of, and what happens as it nears the Sun?','Recall why a comet develops a coma or tail.','Why can an icy comet look different near the Sun than far away?','Introduction',[['ice','icy'],['dust'],['sun','warm','heat'],['gas','coma','tail']]],
  ['kuiper-belt','kuiper','Locate and characterize the Kuiper Belt.','The Kuiper Belt is a region beyond Neptune containing many icy bodies. Some short-period comets originate there.','Where is the Kuiper Belt, and what kind of bodies does it contain?','Recall the Kuiper Belt’s location and typical material.','A learner places the Kuiper Belt between Mars and Jupiter. Correct the location and describe its objects.','Introduction',[['beyond','outside','past'],['neptune'],['ice','icy']]],
  ['oort-cloud','oort','Distinguish the inferred Oort Cloud from a directly imaged structure.','NASA describes the Oort Cloud as a proposed distant shell of icy objects surrounding the solar system. Its existence is inferred from comet behavior and models, not direct imaging.','What is the proposed Oort Cloud, and how do scientists know about it?','Recall its proposed shape, material and evidence status.','Someone says a spacecraft photographed the Oort Cloud. Explain its actual evidence status.','Introduction',[['shell','sphere','spherical'],['ice','icy','comet'],['inferred','model','not directly','unobserved']]],
  ['dwarf-planets','dwarfs','Explain the dwarf planet category using a known example.','NASA lists five officially recognized dwarf planets. Ceres lies in the asteroid belt, while Pluto is beyond Neptune; neither is one of the eight planets.','Name a recognized dwarf planet and explain whether it counts among the eight planets.','Recall one dwarf planet and its classification relative to planets.','A friend counts Pluto as a ninth planet. Give its current classification and another dwarf planet example.','Introduction',[['dwarf'],['pluto','ceres','eris','haumea','makemake'],['eight','not a planet','not one of']]],
  ['pluto','pluto','Identify Pluto’s classification and region.','Pluto is a dwarf planet beyond Neptune in the trans-Neptunian region. It has not cleared its orbital neighborhood as the eight planets have.','What is Pluto classified as, where is it, and what orbital criterion distinguishes it?','Recall Pluto’s category and why it is not one of the eight planets.','Explain why Pluto is a dwarf planet despite orbiting the Sun.','Introduction',[['dwarf'],['neptune','trans-neptunian','kuiper'],['clear','neighborhood','neighbourhood']]],
  ['jupiter','jupiter','Locate Jupiter and identify a notable moon.','Jupiter is the fifth planet from the Sun and the largest planet. Ganymede, one of its moons, is the largest moon in the solar system.','Which planet is fifth from the Sun, and what is notable about its moon Ganymede?','Recall Jupiter’s position and a fact about Ganymede.','Name the fifth planet and explain why Ganymede is notable.','Introduction',[['jupiter'],['fifth','5th','five'],['ganymede'],['largest','biggest']]],
];

const extraSupportIds: Record<string, string[]> = {
  'sun-star': ['solar-fusion'], 'eight-planets': ['dwarf-planets'], 'mercury-nearest': ['mercury-smallest'],
  'venus-hottest': ['venus-atmosphere'], 'new-moon': ['half-lit', 'new-full'],
  'moon-satellite': ['moon-reflection'], 'asteroids': ['asteroid-belt'],
  'comets': ['comet-nucleus', 'comet-coma', 'comet-tail'], 'kuiper-belt': ['kuiper-comets'],
  'oort-cloud': ['oort-inferred'], 'dwarf-planets': ['ceres', 'pluto'],
  'pluto': ['pluto-orbit'], 'jupiter': ['jupiter-ganymede'],
};

export const assessmentCards: Card[] = content.map(([id, cluster, objective, explanation, prompt, recallPrompt, altPrompt, locator, rubric]) => {
  const node = seedGraph.concepts.find(c => c.id === id && c.cluster === cluster)!;
  const support = seedGraph.supports.find(s => s.targetType === 'concept' && s.targetId === id && s.locator === locator)!;
  const source = seedGraph.sources.find(s => s.id === support.sourceId)!;
  const supportIds = [id, ...(extraSupportIds[id] ?? [])];
  const sourceUrls = [...new Set(supportIds.flatMap(targetId => seedGraph.supports
    .filter(s => s.targetType === 'concept' && s.targetId === targetId)
    .map(s => seedGraph.sources.find(source => source.id === s.sourceId)!.url)))];
  return { id, cluster, title: node.title, objective, explanation, prompt, recallPrompt, altPrompt, rubric,
    prerequisites: [], source: source.url, sourceId: source.id, locator, supportIds, sourceUrls, graphVersion: SEED_VERSION,
    graphHash: ASSESSMENT_GRAPH_HASH, cardVersion: ASSESSMENT_VERSION, reviewedAt: ASSESSMENT_REVIEWED_AT, reviewStatus: 'reviewed' };
});
export const ASSESSMENT_CONTENT_HASH = createHash('sha256').update(JSON.stringify(assessmentCards)).digest('hex');

export function availableCard(id: string, graph: ResearchGraph, publishedSeedHash: string): Card | undefined {
  if (publishedSeedHash !== ASSESSMENT_GRAPH_HASH) return undefined;
  const card = assessmentCards.find(c => c.id === id);
  if (!card) return undefined;
  const seedConcept = seedGraph.concepts.find(c => c.id === id);
  const currentConcept = graph.concepts.find(c => c.id === id);
  const supported = card.supportIds.every(targetId => {
    const seedNode = seedGraph.concepts.find(c => c.id === targetId);
    const node = graph.concepts.find(c => c.id === targetId);
    const seedSupport = seedGraph.supports.find(s => s.targetType === 'concept' && s.targetId === targetId);
    const support = graph.supports.find(s => s.targetType === 'concept' && s.targetId === targetId && s.sourceId === seedSupport?.sourceId && s.locator === seedSupport.locator && s.summary === seedSupport.summary);
    const seedSource = seedGraph.sources.find(s => s.id === seedSupport?.sourceId);
    const source = graph.sources.find(s => s.id === seedSource?.id && s.url === seedSource.url && s.publisher === 'NASA Science');
    return Boolean(node && seedNode && node.claim === seedNode.claim && support && source);
  });
  return currentConcept && seedConcept && currentConcept.claim === seedConcept.claim && currentConcept.cluster === card.cluster && supported ? card : undefined;
}
