import { executeLayoutTask } from '../../../../packages/graph-core/src/layout-task';
import type { LayoutReply, LayoutTask } from '../../../../packages/graph-core/src/layout-task';

const scope = self as unknown as { onmessage: (event: MessageEvent<LayoutTask>) => void; postMessage: (reply: LayoutReply) => void };
scope.onmessage = event => {
  try { scope.postMessage({ id: event.data.id, layout: executeLayoutTask(event.data) }); }
  catch { scope.postMessage({ id: event.data.id, error: 'Layout failed. Use Files or retry.' }); }
};
