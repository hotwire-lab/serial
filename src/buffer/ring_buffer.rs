use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkDirection {
    Rx,
    Tx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalChunk {
    pub data: Vec<u8>,
    pub timestamp_ms: u64,
    pub direction: ChunkDirection,
}

/// Bounded ring buffer (up to `max_chunks` and `max_bytes`) for non-destructive
/// switching between ASCII, HEX, Timestamps, and Control Char views.
pub struct RingBuffer {
    chunks: VecDeque<TerminalChunk>,
    total_bytes: usize,
    max_chunks: usize,
    max_bytes: usize,
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self::new(10_000, 2 * 1024 * 1024)
    }
}

impl RingBuffer {
    pub fn new(max_chunks: usize, max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::with_capacity(max_chunks.min(1024)),
            total_bytes: 0,
            max_chunks: max_chunks.max(1),
            max_bytes: max_bytes.max(64),
        }
    }

    pub fn push(&mut self, data: Vec<u8>, timestamp_ms: u64, direction: ChunkDirection) {
        if data.is_empty() {
            return;
        }
        self.total_bytes += data.len();
        self.chunks.push_back(TerminalChunk {
            data,
            timestamp_ms,
            direction,
        });

        while self.chunks.len() > self.max_chunks
            || (self.total_bytes > self.max_bytes && self.chunks.len() > 1)
        {
            if let Some(removed) = self.chunks.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
    }

    pub fn clear(&mut self) {
        self.chunks.clear();
        self.total_bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn chunks(&self) -> impl Iterator<Item = &TerminalChunk> {
        self.chunks.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_when_byte_or_chunk_limit_exceeded() {
        let mut rb = RingBuffer::new(3, 100);
        rb.push(vec![b'a'; 10], 1, ChunkDirection::Rx);
        rb.push(vec![b'b'; 10], 2, ChunkDirection::Rx);
        rb.push(vec![b'c'; 10], 3, ChunkDirection::Rx);
        rb.push(vec![b'd'; 10], 4, ChunkDirection::Rx);
        assert_eq!(rb.len(), 3);
        assert_eq!(rb.total_bytes(), 30);
        assert_eq!(rb.chunks().next().unwrap().timestamp_ms, 2);

        let mut rb_bytes = RingBuffer::new(100, 15);
        rb_bytes.push(vec![1; 10], 1, ChunkDirection::Rx);
        rb_bytes.push(vec![2; 10], 2, ChunkDirection::Rx);
        assert_eq!(rb_bytes.len(), 1);
        assert_eq!(rb_bytes.total_bytes(), 10);
    }
}
