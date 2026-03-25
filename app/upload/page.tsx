import type { Metadata } from 'next';
import UploadForm from './UploadForm';

export const metadata: Metadata = {
  title: 'Upload',
};

export default function UploadPage() {
  return <UploadForm />;
}
