import { useSyncExternalStore } from 'react';
import { getSyncStatus, subscribeSync } from './sync';

export const useSyncStatus = () => useSyncExternalStore(subscribeSync, getSyncStatus);
