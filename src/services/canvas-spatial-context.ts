// Input must already be viewer-authorized. Never resolve sources from geometry.
type Bounds = { x: number; y: number; width: number; height: number; z: number };
type Item = { id: string; layout: Bounds; access?: string; kind?: string };

export function canvasSpatialContext(naplets: Item[], elements: Item[]) {
  const items = [
    ...naplets.filter(item => item.access === 'ready').map(item => ({ type: 'naplet', id: item.id, bounds: item.layout })),
    ...elements.map(item => ({ type: 'element', id: item.id, kind: item.kind, bounds: item.layout })),
  ];
  return {
    version: 1, coordinate_space: 'canvas_world',
    interpretation: 'Viewer-authorized item bounds in canvas world coordinates.',
    items,
  };
}
