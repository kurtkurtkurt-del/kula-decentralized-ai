import { useWindowDimensions } from 'react-native';
import { MAX_WIDTH } from '@/theme/layout';

// The app is a phone-shaped column: on a tablet (or a wide browser) it stays at most
// MAX_WIDTH wide, centred (app/_layout.tsx). Anything sized from the screen takes its
// width from here, not from the window, so a card on a 1200-pixel tablet is still a card.
export function useAppSize() {
  const { width, height } = useWindowDimensions();
  return { width: Math.min(width, MAX_WIDTH), height, wide: width > MAX_WIDTH };
}
