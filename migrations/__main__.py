"""Explicit, forward-only versioned migrations. No application import/startup DDL."""
import argparse
import importlib.util
import os
from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool


def migrate(url):
    parsed = make_url(url)
    if '-pooler.' in (parsed.host or ''):
        raise ValueError('Migrations require a direct connection')
    engine = create_engine(url, hide_parameters=True, poolclass=NullPool)
    try:
        with engine.begin() as connection:
            connection.execute(text('SELECT pg_advisory_xact_lock(38380002)'))
            connection.execute(text('CREATE TABLE IF NOT EXISTS schema_versions (version VARCHAR(100) PRIMARY KEY)'))
            versions = set(connection.scalars(text('SELECT version FROM schema_versions')))
            for path in sorted(Path(__file__).parent.glob('[0-9]*.py')):
                if path.stem in versions:
                    continue
                spec = importlib.util.spec_from_file_location(path.stem, path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                module.upgrade(connection)
                connection.execute(text('INSERT INTO schema_versions(version) VALUES (:v)'), {'v': path.stem})
    finally:
        engine.dispose()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', required=True)
    parser.parse_args()
    url = os.environ.get('MIGRATION_DATABASE_URL')
    if not url:
        raise SystemExit('MIGRATION_DATABASE_URL must explicitly name the target direct database')
    # Baseline imports model helpers, which require configuration but never connect.
    os.environ.setdefault('DATABASE_URL', url)
    migrate(url)
