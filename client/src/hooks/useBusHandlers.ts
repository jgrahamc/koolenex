import { useCallback } from 'react';
import { api } from '../api.ts';
import type { AppState, Action } from '../state.ts';
import type { DeviceStatus } from '../../../shared/types.ts';

export function useBusHandlers(
  state: AppState,
  dispatch: React.Dispatch<Action>,
) {
  const handleConnect = useCallback(
    async (host: string, port: number) => {
      const result = await api.busConnect(host, port, state.activeProjectId!);
      dispatch({
        type: 'SET_BUS',
        status: { connected: true, type: 'udp', host, port, hasLib: true },
      });
      return result;
    },
    [state.activeProjectId],
  );

  const handleConnectUsb = useCallback(
    async (devicePath: string) => {
      const result = await api.busConnectUsb(
        devicePath,
        state.activeProjectId!,
      );
      dispatch({
        type: 'SET_BUS',
        status: {
          connected: true,
          type: 'usb',
          host: null,
          path: devicePath,
          hasLib: true,
        },
      });
      return result;
    },
    [state.activeProjectId],
  );

  const handleDisconnect = useCallback(async () => {
    await api.busDisconnect();
    dispatch({
      type: 'SET_BUS',
      status: { connected: false, host: null, hasLib: state.busStatus.hasLib },
    });
  }, [state.busStatus.hasLib]);

  const handleDeviceStatus = useCallback(
    async (deviceId: number, status: DeviceStatus) => {
      if (!state.activeProjectId) return;
      await api.setDeviceStatus(state.activeProjectId, deviceId, status);
      dispatch({ type: 'SET_DEVICE_STATUS', deviceId, status });
    },
    [state.activeProjectId],
  );

  const handleWrite = useCallback(
    async (ga: string, value: any, dpt: any) => {
      await api.busWrite(ga, value, dpt, state.activeProjectId!);
    },
    [state.activeProjectId],
  );

  const handleClearTelegrams = useCallback(async () => {
    if (state.activeProjectId) await api.clearTelegrams(state.activeProjectId);
    dispatch({ type: 'SET_TELEGRAMS', telegrams: [] });
  }, [state.activeProjectId]);

  return {
    handleConnect,
    handleConnectUsb,
    handleDisconnect,
    handleDeviceStatus,
    handleWrite,
    handleClearTelegrams,
  };
}
