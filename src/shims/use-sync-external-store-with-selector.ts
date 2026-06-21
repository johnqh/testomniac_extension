import {
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

type SnapshotSelector<Snapshot, Selection> = (snapshot: Snapshot) => Selection;
type EqualityFn<Selection> = (left: Selection, right: Selection) => boolean;

function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: SnapshotSelector<Snapshot, Selection>,
  isEqual?: EqualityFn<Selection>
) {
  const instRef = useRef<{ hasValue: boolean; value: Selection | null } | null>(
    null
  );

  if (instRef.current === null) {
    instRef.current = { hasValue: false, value: null };
  }

  const inst = instRef.current;

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot) => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);

        if (
          isEqual !== undefined &&
          inst.hasValue &&
          inst.value !== null &&
          isEqual(inst.value, nextSelection)
        ) {
          memoizedSelection = inst.value;
          return inst.value;
        }

        memoizedSelection = nextSelection;
        return nextSelection;
      }

      if (Object.is(memoizedSnapshot, nextSnapshot)) {
        return memoizedSelection;
      }

      const nextSelection = selector(nextSnapshot);
      if (isEqual !== undefined && isEqual(memoizedSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return memoizedSelection;
      }

      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };

    const maybeGetServerSnapshot =
      getServerSnapshot === undefined ? undefined : getServerSnapshot;

    return [
      () => memoizedSelector(getSnapshot()),
      maybeGetServerSnapshot === undefined
        ? undefined
        : () => memoizedSelector(maybeGetServerSnapshot()),
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual, inst]);

  const value = useSyncExternalStore(
    subscribe,
    getSelection,
    getServerSelection
  );

  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [inst, value]);

  useDebugValue(value);

  return value;
}

const shim = { useSyncExternalStoreWithSelector };

export { useSyncExternalStoreWithSelector };
export default shim;
