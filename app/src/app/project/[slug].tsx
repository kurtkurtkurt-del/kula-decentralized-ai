import Soon from '@/components/Soon';
import { useLocalSearchParams } from 'expo-router';
// The project page comes next; the deck already links here.
export default function ProjectScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  return <Soon title={(slug ?? '').replace(/-/g, ' ')} line="the project page comes next" />;
}
