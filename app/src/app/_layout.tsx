import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { Platform, Text, View } from 'react-native';
import { NavigationBar } from 'expo-navigation-bar';
import * as SplashScreen from 'expo-splash-screen';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import {
  useFonts,
  InterTight_400Regular,
  InterTight_500Medium,
  InterTight_600SemiBold,
} from '@expo-google-fonts/inter-tight';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
// the boundary can sit outside the language provider: read the language directly
import { t as tNow } from '@/i18n/core';
import { colors } from '@/theme/tokens';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { LanguageProvider, useLang } from '@/i18n';
import { usePushRegistration, usePushRouting } from '@/lib/push';
import OfflineBar from '@/components/OfflineBar';
import UpdateGate from '@/components/UpdateGate';
import { catchErrors, logError } from '@/data/safety';
import { startOffline } from '@/lib/offline';
import '@/data/jobs';
import { startWarm } from '@/data/warm';
import { startNightWatch } from '@/night/useNight';
import PillAction from '@/components/PillAction';

// The browser build swaps Alert.alert for window.confirm and friends (web/alert.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- web only
if (Platform.OS === 'web') require('@/web/alert');

// Watch connectivity and flush queued writes as soon as the app starts.
startOffline();
startWarm();
startNightWatch();
// Uncaught errors are written to client_errors (51_safety.sql) for the admin.
catchErrors();

// Keep the native splash up until fonts load so the hand-off is invisible.
SplashScreen.preventAutoHideAsync();
// Expo Go uses its own splash; setOptions is a no-op there and logs a warning.
if (Constants.executionEnvironment !== ExecutionEnvironment.StoreClient) {
  SplashScreen.setOptions({ fade: true, duration: 250 });
}

// Crash reporting (Sentry) was taken out on 21.10.2026: local build, no DSN.

function RootLayout() {
  const [loaded] = useFonts({ InterTight_400Regular, InterTight_500Medium, InterTight_600SemiBold, JetBrainsMono_400Regular, ArchivoLogo: require('../../assets/fonts/ArchivoLogo.ttf') });

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  // Hide Android's system navigation bar; a swipe up reveals it temporarily.
  useEffect(() => {
    if (Platform.OS === 'android') NavigationBar.setHidden(true);
  }, []);

  // Same ink background as the splash while fonts load.
  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.ink }} />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <AuthProvider>
    <LanguageProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          // Pushed pages slide in from the right and back out on return.
          // Back navigation is the edge swipe in BackButton; the native gesture is disabled.
          animation: 'ios_from_right',
          animationDuration: 320,
          gestureEnabled: false,
          contentStyle: { backgroundColor: colors.ink },
        }}
      >
        {/* Flow changes (entry, sign-up, film, arriving at the tabs) cross-fade instead of sliding. */}
        {['index', '(tabs)', 'signup', 'auth-callback'].map((name) => (
          <Stack.Screen key={name} name={name} options={{ animation: 'fade', animationDuration: 400 }} />
        ))}
      </Stack>
      <PushBridge />
      <OfflineBar />
      <UpdateGate />
    </LanguageProvider>
    </AuthProvider>
    </GestureHandlerRootView>
  );
}

// Registers the phone for push once there is an account (again when the language
// changes, so notifications follow it) and opens the screen a tapped notification names.
function PushBridge() {
  const { session, isAnonymous } = useAuth();
  const { lang } = useLang();
  usePushRegistration(!!session && !isAnonymous, lang);
  usePushRouting();
  return null;
}

// A screen that throws: the error is logged and the page offers to try again instead
// of a blank screen (expo-router renders this in place of the route).
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return <Crashed error={error} retry={retry} />;
}
function Crashed({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  useEffect(() => {
    logError(error, 'screen', true);
  }, [error]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 18 }}>
      <Text style={{ fontFamily: 'InterTight_500Medium', fontSize: 22, color: colors.paper, textAlign: 'center' }}>{tNow('crash.title')}</Text>
      <Text style={{ fontFamily: 'JetBrainsMono_400Regular', fontSize: 11, color: colors.mute, textAlign: 'center' }} numberOfLines={3}>{error.message}</Text>
      <PillAction icon="retry" label={tNow('crash.retry')} onPress={() => retry()} />
    </View>
  );
}

export default RootLayout;
