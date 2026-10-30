"""One budget shared by all provider calls in a request; never retry paid calls."""
from contextvars import ContextVar
from time import monotonic

expires = ContextVar('request_deadline', default=None)


def remaining(maximum=30):
    end = expires.get()
    value = maximum if end is None else min(maximum, end - monotonic() - 0.5)
    if value <= 0:
        raise TimeoutError('request_deadline_exceeded')
    return value


def read_bounded(response, limit):
    """Rebudget each socket read so slow responses cannot reset the total budget."""
    if not hasattr(response, 'read1'):
        value = response.read(limit)
        remaining()
        return value
    chunks = []
    total = 0
    while total < limit:
        budget = remaining()
        sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
        if sock is not None:
            sock.settimeout(budget)
        chunk = response.read1(min(65536, limit - total))
        remaining()
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b''.join(chunks)
