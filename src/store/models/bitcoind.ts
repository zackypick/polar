import { ChainInfo, WalletInfo } from 'bitcoin-core';
import { Action, action, Thunk, thunk } from 'easy-peasy';
import { BitcoinNode, Status } from 'shared/types';
import { StoreInjections } from 'types';
import { delay } from 'utils/async';
import { prefixTranslation } from 'utils/translate';
import { RootModel } from './';

const { l } = prefixTranslation('store.models.bitcoind');

export const getNetworkBackendId = (node: BitcoinNode) =>
  `${node.networkId}-${node.name}`;

export interface BitcoindNodeMapping {
  // key must be unique across networks. use getNetworkBackendId(node)
  [key: string]: BitcoindNodeModel;
}

export interface BitcoindNodeModel {
  chainInfo?: ChainInfo;
  walletInfo?: WalletInfo;
}

export interface BitcoindModel {
  nodes: BitcoindNodeMapping;
  removeNode: Action<BitcoindModel, BitcoinNode>;
  clearNodes: Action<BitcoindModel, void>;
  setInfo: Action<
    BitcoindModel,
    { node: BitcoinNode; chainInfo: ChainInfo; walletInfo: WalletInfo }
  >;
  getInfo: Thunk<BitcoindModel, BitcoinNode, StoreInjections>;
  mine: Thunk<
    BitcoindModel,
    { blocks: number; node: BitcoinNode },
    StoreInjections,
    RootModel
  >;
  sendFunds: Thunk<
    BitcoindModel,
    { node: BitcoinNode; toAddress: string; amount: number; autoMine: boolean },
    StoreInjections,
    RootModel,
    Promise<string>
  >;
}

const bitcoindModel: BitcoindModel = {
  // computed properties/functions
  nodes: {}, // reducer actions (mutations allowed thx to immer)
  removeNode: action((state, node) => {
    delete state.nodes[getNetworkBackendId(node)];
  }),
  clearNodes: action(state => {
    state.nodes = {};
  }),
  setInfo: action((state, { node, chainInfo, walletInfo }) => {
    const id = getNetworkBackendId(node);
    if (!state.nodes[id]) state.nodes[id] = {};
    state.nodes[id].chainInfo = chainInfo;
    state.nodes[id].walletInfo = walletInfo;
  }),
  getInfo: thunk(async (actions, node, { injections }) => {
    const chainInfo = await injections.bitcoindService.getBlockchainInfo(node);
    const walletInfo = await injections.bitcoindService.getWalletInfo(node);
    actions.setInfo({ node, chainInfo, walletInfo });
  }),
  mine: thunk(async (actions, { blocks, node }, { injections, getStoreState }) => {
    if (blocks < 0) throw new Error(l('mineError'));

    await injections.bitcoindService.mine(blocks, node);
    // add a small delay to allow the block to propagate to all nodes
    await delay(500);
    // update info for all bitcoin nodes
    const network = getStoreState().network.networkById(node.networkId);
    await Promise.all(
      network.nodes.bitcoin.filter(n => n.status === Status.Started).map(actions.getInfo),
    );
  }),
  sendFunds: thunk(
    async (actions, { node, toAddress, amount, autoMine }, { injections }) => {
      const txid = await injections.bitcoindService.sendFunds(node, toAddress, amount);
      if (autoMine) await actions.mine({ blocks: 6, node });
      return txid;
    },
  ),
};

export default bitcoindModel;
