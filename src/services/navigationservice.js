
const { decideNextState } = require("../services/workflowDecider");




const navigatorService = async (dataFromWorkFlowID) => {
  console.log("NavigatorService", dataFromWorkFlowID);
  const getdecideNextState = await decideNextState(dataFromWorkFlowID);
  return getdecideNextState;
};

module.exports = {
  navigatorService,
};