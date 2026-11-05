import { Redirect } from 'expo-router';

// The messages were a tab of their own until 5.11.2026; they are inside connect now. An old
// link (or a notification) to /messages opens connect on its messages.
export default function MessagesMoved() {
  return <Redirect href={{ pathname: '/people', params: { view: 'messages' } }} />;
}
