import type { Metadata } from 'next';
import DownloadForm from './DownloadForm';

export const metadata: Metadata = {
  title: 'Download',
};

export default function DownloadPage() {
  return <DownloadForm />;
}
