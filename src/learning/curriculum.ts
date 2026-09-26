export const CORPUS = 'learning.space.v1';
export const VERSION = '2026-09-26.1';
export const REVIEWED_AT = '2026-09-26';
export const NASA_SOURCE = 'https://science.nasa.gov/moon/moon-phases/';
export const NASA_QUESTIONS = 'https://science.nasa.gov/moon/top-moon-questions/';

export type Concept = {
  id: string; title: string; explanation: string; objective: string;
  prerequisites: string[]; source: string; prompt: string; recallPrompt: string;
  altPrompt?: string;
  rubric: string[][];
};

export const concepts: Concept[] = [
  { id: 'sun-light', title: 'The Sun is a light source', explanation: 'The Sun supplies the light that reaches Earth and the Moon.', objective: 'Identify the Sun as the source of light in the Earth–Moon system.', prerequisites: [], source: NASA_SOURCE, prompt: 'What lights the Moon?', recallPrompt: 'Where does the light we see on the Moon come from?', rubric: [['sun'], ['light', 'sunlight']] },
  { id: 'moon-reflection', title: 'Moonlight is reflected sunlight', explanation: 'The Moon does not make its own visible light; it reflects sunlight.', objective: 'Explain why the Moon appears bright.', prerequisites: ['sun-light'], source: NASA_SOURCE, prompt: 'Explain why the Moon looks bright at night.', recallPrompt: 'Does the Moon make its own light? Explain.', rubric: [['reflect', 'bounce'], ['sun', 'sunlight']] },
  { id: 'earth-moon-positions', title: 'The Sun, Earth, and Moon have changing positions', explanation: 'The Moon and Earth move relative to the Sun, changing the view from Earth.', objective: 'Describe the Sun, Earth, and Moon as separate bodies with changing relative positions.', prerequisites: ['sun-light'], source: NASA_SOURCE, prompt: 'How can the positions of the Sun, Earth, and Moon change what we see?', recallPrompt: 'Name the three bodies whose positions matter for Moon phases.', rubric: [['sun'], ['earth'], ['moon']] },
  { id: 'moon-orbit', title: 'The Moon orbits Earth', explanation: 'The Moon travels around Earth roughly once each month.', objective: 'Describe the Moon orbiting Earth.', prerequisites: ['earth-moon-positions'], source: NASA_SOURCE, prompt: 'What does the Moon orbit, and why does its position change?', recallPrompt: 'Describe the Moon’s motion around Earth.', rubric: [['moon'], ['earth'], ['orbit', 'around', 'revolve']] },
  { id: 'half-lit', title: 'Half the Moon is sunlit', explanation: 'Except during an eclipse, sunlight illuminates half the Moon at a time.', objective: 'Explain that one half faces sunlight while the other is dark.', prerequisites: ['moon-reflection', 'earth-moon-positions'], source: NASA_SOURCE, prompt: 'At one moment, how much of the Moon is lit by the Sun?', recallPrompt: 'Is only a crescent of the Moon actually lit during a crescent phase?', rubric: [['half', 'one side', 'one hemisphere'], ['sun', 'sunlight']] },
  { id: 'visible-half', title: 'Earth sees part of the lit half', explanation: 'As the Moon orbits, the portion of its sunlit half visible from Earth changes.', objective: 'Connect the visible bright portion to viewing geometry.', prerequisites: ['half-lit', 'moon-orbit'], source: NASA_SOURCE, prompt: 'Why can we see different amounts of the Moon’s lit half?', recallPrompt: 'Why does the bright part visible from Earth change?', rubric: [['orbit', 'position', 'around'], ['earth'], ['lit', 'sunlit', 'illuminat']] },
  { id: 'new-full', title: 'New and full Moon views', explanation: 'At new Moon the near side is mostly dark; at full Moon the near side is sunlit.', objective: 'Compare the Earth-facing lit portion at new and full Moon.', prerequisites: ['visible-half'], source: NASA_SOURCE, prompt: 'Compare what we see at new Moon and full Moon.', recallPrompt: 'When is the Moon’s Earth-facing side mostly lit?', rubric: [['new'], ['full'], ['dark', 'unlit'], ['lit', 'bright']] },
  { id: 'wax-wane', title: 'Waxing and waning', explanation: 'The visible lit portion grows while waxing and shrinks while waning.', objective: 'Describe the direction of visible change.', prerequisites: ['visible-half'], source: NASA_SOURCE, prompt: 'What is the difference between waxing and waning?', recallPrompt: 'If the lit part grows night to night, is it waxing or waning?', rubric: [['wax'], ['grow', 'increase', 'larger'], ['wan'], ['shrink', 'decrease', 'smaller']] },
  { id: 'not-earth-shadow', title: 'Phases are not Earth’s shadow', explanation: 'Earth’s shadow causes a lunar eclipse, not the usual phases.', objective: 'Reject the Earth-shadow misconception using the sunlit-half model.', prerequisites: ['half-lit', 'visible-half'], source: NASA_QUESTIONS, prompt: 'A friend says Moon phases are caused by Earth’s shadow. Explain why that is wrong.', recallPrompt: 'What causes ordinary Moon phases, and what does Earth’s shadow cause?', rubric: [['shadow'], ['eclipse'], ['position', 'orbit', 'view']] },
  { id: 'moon-phases', title: 'Explain Moon phases', explanation: 'Moon phases are the changing view from Earth of the Moon’s sunlit half as it orbits Earth.', objective: 'Explain phases with sunlight, orbit, and the Earth viewpoint.', prerequisites: ['new-full', 'wax-wane', 'not-earth-shadow'], source: NASA_SOURCE, prompt: 'Explain why the Moon appears to change shape during a month. Include the Sun, orbit, and what we see from Earth.', recallPrompt: 'A week later, explain Moon phases to someone who thinks the Moon itself changes shape.', rubric: [['sun', 'sunlight'], ['orbit', 'around'], ['earth'], ['lit', 'bright', 'illuminat']] },
];

export const alternativeQuestions: Record<string, string> = {
  'sun-light': 'If you could turn off the Sun, what would happen to the light falling on the Moon? Explain.',
  'moon-reflection': 'Why can we see the Moon even though it is not a star?',
  'earth-moon-positions': 'Why must a Moon-phase model include the positions of the Sun, Earth, and Moon?',
  'moon-orbit': 'Imagine the Moon one week after today. What movement changed its position relative to Earth?',
  'half-lit': 'A crescent looks narrow from Earth. Explain how much of the whole Moon is sunlit at that moment.',
  'visible-half': 'Why could an observer on Earth see a crescent while the Moon still has a fully sunlit half?',
  'new-full': 'A friend sees a full Moon, then later a new Moon. Compare the Earth-facing lit portions.',
  'wax-wane': 'A Moon looks less bright each night after full Moon. Is it waxing or waning? Explain both terms.',
  'not-earth-shadow': 'Use the usual half-lit Moon model to explain why Earth’s shadow is not needed for monthly phases.',
  'moon-phases': 'Use an imaginary lamp, ball, and observer to explain why Moon phases change without the Moon changing shape.',
};

export function walk(goal: string, nodes: Concept[] = concepts) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: Concept[] = [];
  const cycles: string[][] = [];
  const missing: string[] = [];
  const visit = (id: string, path: string[]) => {
    if (visiting.has(id)) { cycles.push([...path.slice(path.indexOf(id)), id]); return; }
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) { missing.push(id); return; }
    visiting.add(id);
    for (const prerequisite of [...node.prerequisites].sort()) visit(prerequisite, [...path, id]);
    visiting.delete(id);
    visited.add(id);
    order.push(node);
  };
  visit(goal, []);
  return { corpus: CORPUS, version: VERSION, goal, order: order.map(({ id, title, prerequisites, objective }) => ({ id, title, prerequisites, objective })), cycles, missing: [...new Set(missing)].sort(), valid: cycles.length === 0 && missing.length === 0 };
}

export function score(answer: string, rubric: string[][]) {
  const text = answer.toLowerCase();
  const matched = rubric.map(group => group.some(term => text.includes(term)));
  const contradictions = [
    /(?:earth.?s? shadow|shadow of earth) (?:causes?|makes?|creates?) (?:the )?(?:moon )?phases?/,
    /moon (?:makes?|creates?|produces?) (?:its own )?light/,
    /sun (?:does not|doesn't|cannot|can't) light (?:the )?moon/,
    /moon (?:actually|physically) changes? shape/,
  ].filter(pattern => pattern.test(text)).map(pattern => pattern.source);
  return { passed: matched.every(Boolean) && contradictions.length === 0 && answer.trim().split(/\s+/).length >= 4, matched, contradictions, score: matched.filter(Boolean).length / rubric.length };
}
