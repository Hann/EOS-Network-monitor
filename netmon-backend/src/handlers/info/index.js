const {
  GET_INFO_INTERVAL,
  GET_GENERAL_ADDITIONAL_INFO_INTERVAL,
  LISTENERS: { ON_INFO_CHANGE_INTERVAL },
  LAST_BLOCKS_NUMBER_FOR_CALCULATING_AVG_APS_TPS,
} = require('config');

const { eosApi, createLogger, castToInt } = require('../../helpers');
const { StateModelV2 } = require('../../db');
const getActionsCount = require('../../routines/handleBlock/getActionsCount');
const getBlockInfo = require('./getBlockInfo');

const { info: logInfo } = createLogger('INFO_HANDLER');

const blockStorage = {
  max_tps: 0,
  max_tps_block: 0,
  max_aps_block: 0,
  max_aps: 0,
  previous: {},
  last_ten_live_tps: [], // its needed for calculating avg aps and tps
  last_ten_live_aps: [], // its needed for calculating avg aps and tps
  replacedNumber: 0, // its needed for calculating avg aps and tps
};

const avg = arr => {
  const sum = arr.reduce((acc, val) => acc + val, 0);
  return (sum / arr.length).toFixed();
};

const composeData = ({ block, max_tps, max_aps, max_tps_block, max_aps_block }) => {
  const live_tps =
    block.transactions.length + (blockStorage.previous.transactions ? blockStorage.previous.transactions.length : 0);
  const live_aps =
    getActionsCount(block) + (blockStorage.previous.transactions ? getActionsCount(blockStorage.previous) : 0);

  blockStorage.last_ten_live_aps[blockStorage.replacedNumber] = live_aps;
  blockStorage.last_ten_live_tps[blockStorage.replacedNumber] = live_tps;
  blockStorage.replacedNumber += 1;
  if (blockStorage.replacedNumber === LAST_BLOCKS_NUMBER_FOR_CALCULATING_AVG_APS_TPS) {
    blockStorage.replacedNumber = 0;
  }
  return {
    ...block,
    live_tps: avg(blockStorage.last_ten_live_tps),
    live_aps: avg(blockStorage.last_ten_live_aps),
    max_tps,
    max_aps,
    max_tps_block,
    max_aps_block,
  };
};

// initial state
let info = { number: 0, block: {}, info: {} };
const listeners = [];

const notify = () => {
  listeners.forEach(listener => {
    listener({ ...info, info: { ...info.additionalInfo, ...info.info } });
  });
};

const getInfo = async () => {
  try {
    const state = await StateModelV2.findOne({ id: 1 }).exec();
    if (!state) {
      return;
    }

    const nextInfo = await getBlockInfo();
    if (castToInt(info.number) >= castToInt(nextInfo.number)) {
      return;
    }
    blockStorage.previous = {
      ...info.block,
    };
    info = {
      ...info,
      ...nextInfo,
      block: composeData({
        ...nextInfo,
        max_aps: state.max_aps,
        max_tps: state.max_tps,
        max_tps_block: state.max_tps_block,
        max_aps_block: state.max_aps_block,
      }),
    };
  } catch (e) {
    logInfo(e);
  }

  if (ON_INFO_CHANGE_INTERVAL === 0) {
    notify();
  }
};

const getAdditionalInfo = async () => {
  const { rows: [tableInfo] } =
    await eosApi.getTableRows({ json: true, scope: 'eosio', code: 'eosio', table: 'global' });
  const { core_liquid_balance: coreLiquidBalance } = await eosApi.getAccount({ account_name: 'eosio.ramfee' });
  const [savingTotalBalance] = await eosApi.getCurrencyBalance('eosio.token', 'eosio.saving');
  const additionalInfo = {
    maxRamSize: tableInfo.max_ram_size,
    totalUnpaidBlocks: tableInfo.total_unpaid_blocks,
    coreLiquidBalance,
    savingTotalBalance,
  };
  info = {
    ...info,
    additionalInfo,
  };
};

const initInfoHandler = async () => {
  setInterval(getInfo, GET_INFO_INTERVAL);
  setInterval(getAdditionalInfo, GET_GENERAL_ADDITIONAL_INFO_INTERVAL);

  if (ON_INFO_CHANGE_INTERVAL) {
    setInterval(notify, ON_INFO_CHANGE_INTERVAL);
  }

  return {
    onUpdate(listener) {
      listeners.push(listener);
    },
    getBlockInfo(blockNum) {
      return eosApi.getBlock(blockNum);
    },
  };
};

module.exports = initInfoHandler;
