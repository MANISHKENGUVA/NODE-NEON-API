/**
 * Transition resolution.
 *
 * Two pure functions:
 *   - `resolveNextNode`  which node the rule engine reaches from the current one
 *   - `presentForActor`  which node to show the actor who is asking
 *
 * `loan_applications.current_node` always holds the node that is *waiting to be
 * completed*, so presenting a node never re-evaluates the rules; it only hides
 * another actor's page from the caller.
 */
const { getState, getActorForNode, getEntryNodeForActor, isTerminal } = require("./definition");
const { firstMatchingEdge } = require("./ruleEngine");

const ACTOR_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  WAITING: "WAITING",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
});

/** Splits "BORROWER-DETAILS-V1-PERSONAL-INFO-V1" into module + component keys. */
function splitComponentKey(nodeKey) {
  if (!nodeKey) return { module: null, componentKey: null };
  const match = nodeKey.match(/^(.+-V\d+)-(.+)$/);
  if (!match) return { module: nodeKey, componentKey: null };
  return { module: match[1], componentKey: match[2] };
}

/** Next node reached from `nodeKey`, or null when no edge matches. */
function resolveNextNode(nodeKey, context) {
  const state = getState(nodeKey);
  if (!state) return null;
  return firstMatchingEdge(state, context);
}

/** Most recent history entry completed by `actor`. */
function latestNodeForActor(history, actor) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const entryActor = getActorForNode(entry.nodeKey) ?? entry.actor;
    if (entryActor === actor) return entry.nodeKey;
  }
  return null;
}

/**
 * The node an actor should render.
 *
 * @param {object} input
 * @param {string} input.currentNode  node waiting to be completed
 * @param {string} input.actor        actor of the requesting session
 * @param {Array<{nodeKey: string, actor: string}>} input.history  completed nodes
 * @returns {{node: string|null, actorStatus: string, message: string|null}}
 */
function presentForActor({ currentNode, actor, history = [] }) {
  const currentNodeActor = getActorForNode(currentNode);

  if (!currentNodeActor || currentNodeActor === actor) {
    return { node: currentNode, actorStatus: ACTOR_STATUS.ACTIVE, message: null };
  }

  const ownNode = latestNodeForActor(history, actor);
  if (ownNode) {
    return {
      node: ownNode,
      actorStatus: ACTOR_STATUS.WAITING,
      message: `Waiting for the ${currentNodeActor} step`,
    };
  }

  return {
    node: getEntryNodeForActor(actor),
    actorStatus: ACTOR_STATUS.NOT_YOUR_TURN,
    message: `Workflow has not reached the ${actor} stage yet`,
  };
}

/** API representation of a node. */
function describeNode(nodeKey) {
  return {
    node: nodeKey,
    component: getState(nodeKey)?.component ?? null,
    componentView: splitComponentKey(nodeKey),
    terminal: isTerminal(nodeKey),
  };
}

module.exports = {
  ACTOR_STATUS,
  splitComponentKey,
  resolveNextNode,
  latestNodeForActor,
  presentForActor,
  describeNode,
};
