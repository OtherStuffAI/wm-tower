// Input must already be viewer-authorized. Never resolve sources from geometry.
type Bounds = { x: number; y: number; width: number; height: number; z: number };
type Item = { id: string; layout: Bounds; access?: string; kind?: string };
type Comment = { id: string; parent_comment_id: string | null; anchor: { type: string; naplet_id?: string | null; x?: number; y?: number } };

export function canvasSpatialContext(naplets: Item[], elements: Item[], comments: Comment[]) {
  const items = [
    ...naplets.filter(item => item.access === 'ready').map(item => ({ type: 'naplet', id: item.id, bounds: item.layout })),
    ...elements.map(item => ({ type: 'element', id: item.id, kind: item.kind, bounds: item.layout })),
  ];
  return {
    version: 1, coordinate_space: 'canvas_world',
    interpretation: 'Explicit targets are authoritative. Proximity candidates are geometric inference only, never assigned intent.',
    items,
    comments: comments.map(comment => {
      const root = comment.parent_comment_id ? comments.find(row => row.id === comment.parent_comment_id) : comment;
      const anchor = root?.anchor || comment.anchor;
      const target = anchor.type === 'naplet' ? items.find(item => item.type === 'naplet' && item.id === anchor.naplet_id) : undefined;
      const position = { x: anchor.x ?? (target ? target.bounds.x + target.bounds.width : 0), y: anchor.y ?? target?.bounds.y ?? 0 };
      return {
        comment_id: comment.id, root_comment_id: root?.id || comment.id, position,
        explicit_target: target ? { type: 'naplet', id: target.id, authority: 'explicit' } : null,
        proximity_candidates: target ? [] : items.map(item => ({
          type: item.type, id: item.id, basis: 'geometric_inference',
          distance_to_bounds: Math.round(Math.hypot(Math.max(item.bounds.x - position.x, 0, position.x - item.bounds.x - item.bounds.width), Math.max(item.bounds.y - position.y, 0, position.y - item.bounds.y - item.bounds.height))),
        })).sort((a, b) => a.distance_to_bounds - b.distance_to_bounds || a.id.localeCompare(b.id)).slice(0, 5),
      };
    }),
  };
}
