import {
  CloseOutlined,
  ExportOutlined,
  FormOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import styled from '@emotion/styled';
import { Button, Divider, Dropdown, Menu, MenuProps, Tag } from 'antd';
import { ButtonType } from 'antd/lib/button';
import AutoMineButton from 'components/designer/AutoMineButton';
import { useMiningAsync } from 'hooks/useMiningAsync';
import SyncButton from 'components/designer/SyncButton';
import { usePrefixedTranslation } from 'hooks';
import React, { ReactNode, useCallback } from 'react';
import { Status } from 'shared/types';
import { useStoreState } from 'store';
import { Network } from 'types';
import { getNetworkBackendId } from 'store/models/bitcoind';

const Styled = {
  Button: styled(Button)`
    margin-left: 0;
  `,
  Menu: styled(Menu)`
    .ant-dropdown-menu-title-content {
      svg {
        margin-right: 5px;
      }
    }
  `,
  Dropdown: styled(Dropdown)`
    margin-left: 12px;
  `,
};

interface Props {
  network: Network;
  onClick: () => void;
  onRenameClick: () => void;
  onDeleteClick: () => void;
  onExportClick: () => void;
}

const config: {
  [key: number]: {
    label: string;
    type: ButtonType;
    danger?: boolean;
    icon: ReactNode;
  };
} = {
  [Status.Starting]: {
    label: 'Starting',
    type: 'primary',
    icon: '',
  },
  [Status.Started]: {
    label: 'Stop',
    type: 'primary',
    danger: true,
    icon: <StopOutlined />,
  },
  [Status.Stopping]: {
    label: 'Stopping',
    type: 'default',
    icon: '',
  },
  [Status.Stopped]: {
    label: 'Start',
    type: 'primary',
    icon: <PlayCircleOutlined />,
  },
  [Status.Error]: {
    label: 'Restart',
    type: 'primary',
    danger: true,
    icon: <WarningOutlined />,
  },
};

const NetworkActions: React.FC<Props> = ({
  network,
  onClick,
  onRenameClick,
  onDeleteClick,
  onExportClick,
}) => {
  const { l } = usePrefixedTranslation('cmps.network.NetworkActions');

  const { status, nodes } = network;
  const bitcoinNode = nodes.bitcoin[0];
  const loading = status === Status.Starting || status === Status.Stopping;
  const started = status === Status.Started;
  const { label, type, danger, icon } = config[status];

  const nodeState = useStoreState(
    (s: any) => s.bitcoind.nodes[getNetworkBackendId(bitcoinNode)],
  );

  const mineAsync = useMiningAsync(network);

  const handleClick: MenuProps['onClick'] = useCallback(info => {
    switch (info.key) {
      case 'rename':
        onRenameClick();
        break;
      case 'export':
        onExportClick();
        break;
      case 'delete':
        onDeleteClick();
        break;
    }
  }, []);

  const items: MenuProps['items'] = [
    { key: 'rename', label: l('menuRename'), icon: <FormOutlined /> },
    { key: 'export', label: l('menuExport'), icon: <ExportOutlined /> },
    { key: 'delete', label: l('menuDelete'), icon: <CloseOutlined /> },
  ];

  return (
    <>
      {bitcoinNode.status === Status.Started && nodeState?.chainInfo && (
        <>
          <Tag>height: {nodeState.chainInfo.blocks}</Tag>
          <Button
            onClick={mineAsync.execute}
            loading={mineAsync.loading}
            icon={<ToolOutlined />}
          >
            {l('mineBtn')}
          </Button>
          <AutoMineButton network={network} />
          <SyncButton network={network} />
          <Divider type="vertical" />
        </>
      )}
      <Styled.Button
        key="start"
        type={type}
        danger={danger}
        icon={icon}
        loading={loading}
        ghost={started}
        onClick={onClick}
      >
        {l(`primaryBtn${label}`)}
      </Styled.Button>
      <Styled.Dropdown
        key="options"
        overlay={<Styled.Menu theme="dark" items={items} onClick={handleClick} />}
      >
        <Button icon={<MoreOutlined />} />
      </Styled.Dropdown>
    </>
  );
};

export default NetworkActions;
