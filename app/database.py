from collections.abc import Generator
from fastapi import Depends
from .auth import current_user

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATABASE_URL, APP_ENV
from sqlalchemy.pool import NullPool

engine = create_engine(DATABASE_URL, hide_parameters=True, pool_pre_ping=True, **(
    {"poolclass": NullPool, "connect_args": {"connect_timeout": 5}}
    if APP_ENV == "cloud" else {}))
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db(owner: str = Depends(current_user)) -> Generator[Session, None, None]:
    db = SessionLocal()
    db.info["user_id"] = owner
    try:
        yield db
    finally:
        db.close()


# Transaction-scoped settings work with Neon transaction pooling; no session SET.
if APP_ENV == 'cloud':
    from sqlalchemy import event
    from .deadline import remaining

    @event.listens_for(SessionLocal, 'after_begin')
    def transaction_budget(session, transaction, connection):
        milliseconds = max(1, min(5000, int(remaining() * 1000)))
        connection.exec_driver_sql(f'SET LOCAL statement_timeout = {milliseconds}')
        connection.exec_driver_sql('SET LOCAL idle_in_transaction_session_timeout = 10000')
