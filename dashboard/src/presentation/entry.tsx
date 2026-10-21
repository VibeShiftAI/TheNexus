import { createRoot } from 'react-dom/client';
import { PresentationScreen } from '../components/presentation/presentation-screen';
import { ReceiverPairing } from '../components/presentation/receiver-pairing';
import { presentationTransport } from '../lib/presentation-transport';

const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('mode') === 'controller' ? params.get('session') : null;
const root = createRoot(document.getElementById('presentation')!);
if (document.documentElement.dataset.nexusReceiver === 'cast') {
  root.render(<ReceiverPairing cast />);
} else if (sessionId && /^[A-Za-z0-9_.:-]{1,240}$/.test(sessionId)) {
  root.render(<PresentationScreen {...presentationTransport(sessionId)} />);
} else {
  root.render(<ReceiverPairing />);
}
