import * as React from 'react';
import useLayoutEffect from 'use-isomorphic-layout-effect';
import {useFloatingParentNodeId, useFloatingTree} from '../FloatingTree';
import type {ElementProps, FloatingContext, ReferenceType} from '../types';
import {getDocument} from '../utils/getDocument';
import {activeElement} from '../utils/activeElement';
import {isHTMLElement} from '../utils/is';
import {stopEvent} from '../utils/stopEvent';
import {useLatestRef} from '../utils/useLatestRef';
import {useEvent} from '../utils/useEvent';

const ARROW_UP = 'ArrowUp';
const ARROW_DOWN = 'ArrowDown';
const ARROW_LEFT = 'ArrowLeft';
const ARROW_RIGHT = 'ArrowRight';

function isDifferentRow(index: number, cols: number, prevRow: number) {
  return Math.floor(index / cols) !== prevRow;
}

function isIndexOutOfBounds(
  listRef: React.MutableRefObject<Array<HTMLElement | null>>,
  index: number
) {
  return index < 0 || index >= listRef.current.length;
}

function findNonDisabledIndex(
  listRef: React.MutableRefObject<Array<HTMLElement | null>>,
  {
    startingIndex = -1,
    decrement = false,
    disabledIndices,
    amount = 1,
  }: {
    startingIndex?: number;
    decrement?: boolean;
    disabledIndices?: Array<number>;
    amount?: number;
  } = {}
): number {
  const list = listRef.current;

  let index = startingIndex;
  do {
    index = index + (decrement ? -amount : amount);
  } while (
    index >= 0 &&
    index <= list.length - 1 &&
    (disabledIndices
      ? disabledIndices.includes(index)
      : list[index] == null ||
        list[index]?.hasAttribute('disabled') ||
        list[index]?.getAttribute('aria-disabled') === 'true')
  );

  return index;
}

function doSwitch(
  orientation: Props['orientation'],
  vertical: boolean,
  horizontal: boolean
) {
  switch (orientation) {
    case 'vertical':
      return vertical;
    case 'horizontal':
      return horizontal;
    default:
      return vertical || horizontal;
  }
}

function isMainOrientationKey(key: string, orientation: Props['orientation']) {
  const vertical = key === ARROW_UP || key === ARROW_DOWN;
  const horizontal = key === ARROW_LEFT || key === ARROW_RIGHT;
  return doSwitch(orientation, vertical, horizontal);
}

function isMainOrientationToEndKey(
  key: string,
  orientation: Props['orientation'],
  rtl: boolean
) {
  const vertical = key === ARROW_DOWN;
  const horizontal = rtl ? key === ARROW_LEFT : key === ARROW_RIGHT;
  return (
    doSwitch(orientation, vertical, horizontal) ||
    key === 'Enter' ||
    key == ' ' ||
    key === ''
  );
}

function isCrossOrientationOpenKey(
  key: string,
  orientation: Props['orientation'],
  rtl: boolean
) {
  const vertical = rtl ? key === ARROW_LEFT : key === ARROW_RIGHT;
  const horizontal = key === ARROW_DOWN;
  return doSwitch(orientation, vertical, horizontal);
}

function isCrossOrientationCloseKey(
  key: string,
  orientation: Props['orientation'],
  rtl: boolean
) {
  const vertical = rtl ? key === ARROW_RIGHT : key === ARROW_LEFT;
  const horizontal = key === ARROW_UP;
  return doSwitch(orientation, vertical, horizontal);
}

function getMinIndex(
  listRef: Props['listRef'],
  disabledIndices: Array<number> | undefined
) {
  return findNonDisabledIndex(listRef, {disabledIndices});
}

function getMaxIndex(
  listRef: Props['listRef'],
  disabledIndices: Array<number> | undefined
) {
  return findNonDisabledIndex(listRef, {
    decrement: true,
    startingIndex: listRef.current.length,
    disabledIndices,
  });
}

export interface Props {
  listRef: React.MutableRefObject<Array<HTMLElement | null>>;
  activeIndex: number | null;
  onNavigate?: (index: number | null) => void;
  enabled?: boolean;
  selectedIndex?: number | null;
  focusItemOnOpen?: boolean | 'auto';
  focusItemOnHover?: boolean;
  openOnArrowKeyDown?: boolean;
  disabledIndices?: Array<number>;
  allowEscape?: boolean;
  loop?: boolean;
  nested?: boolean;
  rtl?: boolean;
  virtual?: boolean;
  orientation?: 'vertical' | 'horizontal' | 'both';
  cols?: number;
}

/**
 * Adds focus-managed indexed navigation via arrow keys to a list of items
 * within the floating element.
 * @see https://floating-ui.com/docs/useListNavigation
 */
export const useListNavigation = <RT extends ReferenceType = ReferenceType>(
  {open, onOpenChange, refs}: FloatingContext<RT>,
  {
    listRef,
    activeIndex,
    onNavigate: unstable_onNavigate = () => {},
    enabled = true,
    selectedIndex = null,
    allowEscape = false,
    loop = false,
    nested = false,
    rtl = false,
    virtual = false,
    focusItemOnOpen = 'auto',
    focusItemOnHover = true,
    openOnArrowKeyDown = true,
    disabledIndices = undefined,
    orientation = 'vertical',
    cols = 1,
  }: Props = {
    listRef: {current: []},
    activeIndex: null,
    onNavigate: () => {},
  }
): ElementProps => {
  if (__DEV__) {
    if (allowEscape) {
      if (!loop) {
        console.warn(
          [
            'Floating UI: `useListNavigation` looping must be enabled to allow',
            'escaping.',
          ].join(' ')
        );
      }

      if (!virtual) {
        console.warn(
          [
            'Floating UI: `useListNavigation` must be virtual to allow',
            'escaping.',
          ].join(' ')
        );
      }
    }

    if (orientation === 'vertical' && cols > 1) {
      console.warn(
        [
          'Floating UI: In grid list navigation mode (`cols` > 1), the',
          '`orientation` should be either "horizontal" or "both".',
        ].join(' ')
      );
    }
  }

  const parentId = useFloatingParentNodeId();
  const tree = useFloatingTree();
  const onNavigate = useEvent(unstable_onNavigate);

  const focusItemOnOpenRef = React.useRef(focusItemOnOpen);
  const indexRef = React.useRef(selectedIndex ?? -1);
  const keyRef = React.useRef<null | string>(null);
  const disabledIndicesRef = useLatestRef(disabledIndices);
  const blockPointerLeaveRef = React.useRef(false);
  const frameRef = React.useRef(-1);
  const previousOnNavigateRef = React.useRef(onNavigate);
  const previousOpenRef = React.useRef(open);

  const [activeId, setActiveId] = React.useState<string | undefined>();

  const focusItem = React.useCallback(
    (
      listRef: React.MutableRefObject<Array<HTMLElement | null>>,
      indexRef: React.MutableRefObject<number>
    ) => {
      // `mousedown` clicks occur before `focus`, so the button will steal the
      // focus unless we wait a frame.
      frameRef.current = requestAnimationFrame(() => {
        if (virtual) {
          setActiveId(listRef.current[indexRef.current]?.id);
        } else {
          listRef.current[indexRef.current]?.focus({preventScroll: true});
        }
      });
    },
    [virtual]
  );

  // Sync `selectedIndex` to be the `activeIndex` upon opening the floating
  // element. Also, reset `activeIndex` upon closing the floating element.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    if (open) {
      if (focusItemOnOpenRef.current && selectedIndex != null) {
        onNavigate(selectedIndex);
      }
    } else if (previousOpenRef.current) {
      // Since the user can specify `onNavigate` conditionally
      // (onNavigate: open ? setActiveIndex : setSelectedIndex),
      // we store and call the previous function
      cancelAnimationFrame(frameRef.current);
      previousOnNavigateRef.current(null);
    }
  }, [enabled, open, selectedIndex, listRef, focusItem, onNavigate]);

  // Sync `activeIndex` to be the focused item while the floating element is
  // open.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    if (open) {
      if (activeIndex == null) {
        if (selectedIndex != null) {
          return;
        }

        // Reset while the floating element was open (e.g. the list changed).
        if (previousOpenRef.current) {
          indexRef.current = -1;
          focusItem(listRef, indexRef);
        }

        // Initial sync
        if (
          !previousOpenRef.current &&
          focusItemOnOpenRef.current &&
          (keyRef.current != null ||
            (focusItemOnOpenRef.current === true && keyRef.current == null))
        ) {
          indexRef.current =
            keyRef.current == null ||
            isMainOrientationToEndKey(keyRef.current, orientation, rtl) ||
            nested
              ? getMinIndex(listRef, disabledIndicesRef.current)
              : getMaxIndex(listRef, disabledIndicesRef.current);

          onNavigate(indexRef.current);
        }
      } else if (!isIndexOutOfBounds(listRef, activeIndex)) {
        indexRef.current = activeIndex;
        focusItem(listRef, indexRef);
      }
    }
  }, [
    enabled,
    open,
    activeIndex,
    selectedIndex,
    nested,
    listRef,
    allowEscape,
    orientation,
    rtl,
    virtual,
    onNavigate,
    focusItem,
    disabledIndicesRef,
  ]);

  // Ensure the parent floating element has focus when a nested child closes
  // to allow arrow key navigation to work after the pointer leaves the child.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    if (previousOpenRef.current && !open) {
      const parentFloating = tree?.nodesRef.current.find(
        (node) => node.id === parentId
      )?.context?.refs.floating.current;

      if (
        parentFloating &&
        !parentFloating.contains(activeElement(getDocument(parentFloating)))
      ) {
        parentFloating.focus({preventScroll: true});
      }
    }
  }, [enabled, open, tree, parentId]);

  useLayoutEffect(() => {
    keyRef.current = null;
    previousOnNavigateRef.current = onNavigate;
    previousOpenRef.current = open;
  });

  return React.useMemo(() => {
    if (!enabled) {
      return {};
    }

    const disabledIndices = disabledIndicesRef.current;

    function onKeyDown(event: React.KeyboardEvent) {
      blockPointerLeaveRef.current = true;

      if (nested && isCrossOrientationCloseKey(event.key, orientation, rtl)) {
        stopEvent(event);
        onOpenChange(false);

        if (isHTMLElement(refs.domReference.current)) {
          refs.domReference.current.focus();
        }

        return;
      }

      const currentIndex = indexRef.current;
      const minIndex = getMinIndex(listRef, disabledIndices);
      const maxIndex = getMaxIndex(listRef, disabledIndices);

      if (event.key === 'Home') {
        indexRef.current = minIndex;
        onNavigate(indexRef.current);
      }

      if (event.key === 'End') {
        indexRef.current = maxIndex;
        onNavigate(indexRef.current);
      }

      // Grid navigation
      if (cols > 1) {
        const prevIndex = indexRef.current;

        if (event.key === ARROW_UP) {
          stopEvent(event);

          if (prevIndex === -1) {
            indexRef.current = maxIndex;
          } else {
            indexRef.current = findNonDisabledIndex(listRef, {
              startingIndex: prevIndex,
              amount: cols,
              decrement: true,
              disabledIndices,
            });

            if (loop && (prevIndex - cols < minIndex || indexRef.current < 0)) {
              const col = prevIndex % cols;
              const maxCol = maxIndex % cols;
              const offset = maxIndex - (maxCol - col);

              if (maxCol === col) {
                indexRef.current = maxIndex;
              } else {
                indexRef.current = maxCol > col ? offset : offset - cols;
              }
            }
          }

          if (isIndexOutOfBounds(listRef, indexRef.current)) {
            indexRef.current = prevIndex;
          }

          onNavigate(indexRef.current);
        }

        if (event.key === ARROW_DOWN) {
          stopEvent(event);

          if (prevIndex === -1) {
            indexRef.current = minIndex;
          } else {
            indexRef.current = findNonDisabledIndex(listRef, {
              startingIndex: prevIndex,
              amount: cols,
              disabledIndices,
            });

            if (loop && prevIndex + cols > maxIndex) {
              indexRef.current = findNonDisabledIndex(listRef, {
                startingIndex: (prevIndex % cols) - cols,
                amount: cols,
                disabledIndices,
              });
            }
          }

          if (isIndexOutOfBounds(listRef, indexRef.current)) {
            indexRef.current = prevIndex;
          }

          onNavigate(indexRef.current);
        }

        // Remains on the same row/column
        if (orientation === 'both') {
          const prevRow = Math.floor(prevIndex / cols);

          if (event.key === ARROW_RIGHT) {
            stopEvent(event);

            if (prevIndex % cols !== cols - 1) {
              indexRef.current = findNonDisabledIndex(listRef, {
                startingIndex: prevIndex,
                disabledIndices,
              });

              if (loop && isDifferentRow(indexRef.current, cols, prevRow)) {
                indexRef.current = findNonDisabledIndex(listRef, {
                  startingIndex: prevIndex - (prevIndex % cols) - 1,
                  disabledIndices,
                });
              }
            } else if (loop) {
              indexRef.current = findNonDisabledIndex(listRef, {
                startingIndex: prevIndex - (prevIndex % cols) - 1,
                disabledIndices,
              });
            }

            if (isDifferentRow(indexRef.current, cols, prevRow)) {
              indexRef.current = prevIndex;
            }
          }

          if (event.key === ARROW_LEFT) {
            stopEvent(event);

            if (prevIndex % cols !== 0) {
              indexRef.current = findNonDisabledIndex(listRef, {
                startingIndex: prevIndex,
                disabledIndices,
                decrement: true,
              });

              if (loop && isDifferentRow(indexRef.current, cols, prevRow)) {
                indexRef.current = findNonDisabledIndex(listRef, {
                  startingIndex: prevIndex + (cols - (prevIndex % cols)),
                  decrement: true,
                  disabledIndices,
                });
              }
            } else if (loop) {
              indexRef.current = findNonDisabledIndex(listRef, {
                startingIndex: prevIndex + (cols - (prevIndex % cols)),
                decrement: true,
                disabledIndices,
              });
            }

            if (isDifferentRow(indexRef.current, cols, prevRow)) {
              indexRef.current = prevIndex;
            }
          }

          const lastRow = Math.floor(maxIndex / cols) === prevRow;

          if (isIndexOutOfBounds(listRef, indexRef.current)) {
            if (loop && lastRow) {
              indexRef.current =
                event.key === ARROW_LEFT
                  ? maxIndex
                  : findNonDisabledIndex(listRef, {
                      startingIndex: prevIndex - (prevIndex % cols) - 1,
                      disabledIndices,
                    });
            } else {
              indexRef.current = prevIndex;
            }
          }

          onNavigate(indexRef.current);
          return;
        }
      }

      if (isMainOrientationKey(event.key, orientation)) {
        stopEvent(event);

        // Reset the index if no item is focused.
        if (
          open &&
          !virtual &&
          activeElement(event.currentTarget.ownerDocument) ===
            event.currentTarget
        ) {
          indexRef.current = isMainOrientationToEndKey(
            event.key,
            orientation,
            rtl
          )
            ? minIndex
            : maxIndex;
          onNavigate(indexRef.current);
          return;
        }

        if (isMainOrientationToEndKey(event.key, orientation, rtl)) {
          if (loop) {
            indexRef.current =
              currentIndex >= maxIndex
                ? allowEscape && currentIndex !== listRef.current.length
                  ? -1
                  : minIndex
                : findNonDisabledIndex(listRef, {
                    startingIndex: currentIndex,
                    disabledIndices,
                  });
          } else {
            indexRef.current = Math.min(
              maxIndex,
              findNonDisabledIndex(listRef, {
                startingIndex: currentIndex,
                disabledIndices,
              })
            );
          }
        } else {
          if (loop) {
            indexRef.current =
              currentIndex <= minIndex
                ? allowEscape && currentIndex !== -1
                  ? listRef.current.length
                  : maxIndex
                : findNonDisabledIndex(listRef, {
                    startingIndex: currentIndex,
                    decrement: true,
                    disabledIndices,
                  });
          } else {
            indexRef.current = Math.max(
              minIndex,
              findNonDisabledIndex(listRef, {
                startingIndex: currentIndex,
                decrement: true,
                disabledIndices,
              })
            );
          }
        }

        if (isIndexOutOfBounds(listRef, indexRef.current)) {
          onNavigate(null);
        } else {
          onNavigate(indexRef.current);
        }
      }
    }

    return {
      reference: {
        ...(virtual &&
          open &&
          activeIndex != null && {
            'aria-activedescendant': activeId,
          }),
        onKeyDown(event) {
          blockPointerLeaveRef.current = true;

          if (virtual && open) {
            return onKeyDown(event);
          }

          const isNavigationKey =
            event.key.indexOf('Arrow') === 0 ||
            event.key === 'Enter' ||
            event.key === ' ' ||
            event.key === '';

          if (isNavigationKey) {
            keyRef.current = event.key;
          }

          if (nested) {
            if (isCrossOrientationOpenKey(event.key, orientation, rtl)) {
              stopEvent(event);

              if (open) {
                indexRef.current = getMinIndex(listRef, disabledIndices);
                onNavigate(indexRef.current);
              } else {
                onOpenChange(true);
              }
            }

            return;
          }

          if (isMainOrientationKey(event.key, orientation)) {
            if (selectedIndex != null) {
              indexRef.current = selectedIndex;
            }

            stopEvent(event);

            if (!open && openOnArrowKeyDown) {
              onOpenChange(true);
            } else {
              onKeyDown(event);
            }

            if (open) {
              onNavigate(indexRef.current);
            }
          }
        },
      },
      floating: {
        'aria-orientation': orientation === 'both' ? undefined : orientation,
        ...(virtual &&
          activeIndex != null && {
            'aria-activedescendant': activeId,
          }),
        onKeyDown,
        onPointerMove() {
          blockPointerLeaveRef.current = false;
        },
        onBlur(event) {
          const lostFocusToGuard =
            event.relatedTarget?.getAttribute('data-floating-ui-focus-guard') !=
            null;

          // shift+tab back to the reference element should unset the
          // `activeIndex`.
          if (lostFocusToGuard) {
            onNavigate(null);
          }
        },
      },
      item: {
        onFocus({currentTarget}) {
          const index = listRef.current.indexOf(currentTarget);
          if (index !== -1) {
            onNavigate(index);
          }
        },
        onClick: ({currentTarget}) =>
          currentTarget.focus({preventScroll: true}), // Safari
        ...(focusItemOnHover && {
          onMouseMove({currentTarget}) {
            const target = currentTarget as HTMLButtonElement | null;
            if (target) {
              const index = listRef.current.indexOf(target);
              if (index !== -1) {
                onNavigate(index);
              }
            }
          },
          onPointerLeave() {
            if (!blockPointerLeaveRef.current) {
              indexRef.current = -1;
              focusItem(listRef, indexRef);

              onNavigate(null);
              if (!virtual) {
                requestAnimationFrame(() => {
                  refs.floating.current?.focus({preventScroll: true});
                });
              }
            }
          },
        }),
      },
    };
  }, [
    activeId,
    disabledIndicesRef,
    listRef,
    enabled,
    orientation,
    rtl,
    virtual,
    open,
    activeIndex,
    nested,
    selectedIndex,
    openOnArrowKeyDown,
    focusItemOnHover,
    allowEscape,
    cols,
    loop,
    refs,
    focusItem,
    onNavigate,
    onOpenChange,
  ]);
};
