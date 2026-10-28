import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button, Card } from '../ui/primitives';
import { EmptyState } from '../ui/states';

export function NotFoundPage() {
  return (
    <Card>
      <EmptyState
        icon={<Compass className="h-5 w-5" />}
        title="Page not found"
        description="That address does not match any page."
        action={
          <Link to="/">
            <Button>Go to the dashboard</Button>
          </Link>
        }
      />
    </Card>
  );
}
