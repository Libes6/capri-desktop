//! A bare HTTP/1.1 POST to the loopback bridge. No client library: the request is tiny and
//! every wait is bounded, so the assistant is never held up.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 47823;

/// `Number(process.env.CAPRI_PORT) || 47823`
pub fn port_from(value: Option<&str>) -> u16 {
    let Some(v) = value else { return DEFAULT_PORT };
    match crate::js::trim(v).parse::<f64>() {
        Ok(n) if n.fract() == 0.0 && (1.0..=65535.0).contains(&n) => n as u16,
        _ => DEFAULT_PORT,
    }
}

pub fn request(port: u16, body: &str) -> Vec<u8> {
    let mut r = format!(
        "POST /event HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    r.extend_from_slice(body.as_bytes());
    r
}

/// Send one event and wait for the response to finish. Gives up silently after `io_timeout`
/// of inactivity or at `deadline`, whichever comes first. Returns whether the bridge answered.
pub fn post_event(port: u16, body: &str, io_timeout: Duration, deadline: Instant) -> bool {
    let left = |d: Duration| d.min(deadline.saturating_duration_since(Instant::now()));
    let t = left(io_timeout);
    if t.is_zero() {
        return false;
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, t) else { return false };
    let _ = s.set_nodelay(true);
    let _ = s.set_write_timeout(Some(left(io_timeout).max(Duration::from_millis(1))));
    if s.write_all(&request(port, body)).is_err() {
        return false;
    }
    let mut buf = [0u8; 1024];
    let mut head = Vec::new();
    loop {
        let t = left(io_timeout);
        if t.is_zero() {
            return false;
        }
        let _ = s.set_read_timeout(Some(t));
        match s.read(&mut buf) {
            Ok(0) => return !head.is_empty(),
            Ok(n) => {
                if head.len() < 4096 {
                    head.extend_from_slice(&buf[..n]);
                }
            }
            Err(_) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn port_rules_match_node() {
        assert_eq!(port_from(None), 47823);
        assert_eq!(port_from(Some("")), 47823);
        assert_eq!(port_from(Some("abc")), 47823);
        assert_eq!(port_from(Some("0")), 47823);
        assert_eq!(port_from(Some(" 5000 ")), 5000);
    }

    #[test]
    fn sends_the_body_and_reads_the_answer() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut got = Vec::new();
            let mut b = [0u8; 4096];
            while !String::from_utf8_lossy(&got).contains("{\"a\":1}") {
                let n = c.read(&mut b).unwrap();
                got.extend_from_slice(&b[..n]);
            }
            c.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}").unwrap();
            String::from_utf8(got).unwrap()
        });
        let ok = post_event(port, "{\"a\":1}", Duration::from_millis(800), Instant::now() + Duration::from_secs(2));
        let req = h.join().unwrap();
        assert!(ok);
        assert!(req.starts_with("POST /event HTTP/1.1\r\n"));
        assert!(req.contains("content-length: 7\r\n"));
        assert!(req.ends_with("{\"a\":1}"));
    }

    #[test]
    fn closed_port_returns_quickly() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let t = Instant::now();
        assert!(!post_event(port, "{}", Duration::from_millis(800), Instant::now() + Duration::from_secs(2)));
        assert!(t.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn silent_server_is_abandoned_at_the_timeout() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = Instant::now();
        assert!(!post_event(port, "{}", Duration::from_millis(300), Instant::now() + Duration::from_secs(2)));
        assert!(t.elapsed() < Duration::from_millis(900));
        drop(l);
    }
}
