//! Per-version indexes that let expansion find a node's candidate files without
//! rescanning every file for every node.
use aho_corasick::AhoCorasick;
use anyhow::Result;
use std::collections::HashMap;
use std::rc::Rc;

/// Bytes that can be part of an identifier-like token. Non-ASCII bytes count, so a
/// UTF-8 identifier is one token.
pub(crate) fn token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 0x80
}

/// Maximal runs of token bytes.
pub(crate) fn tokens(content: &[u8]) -> impl Iterator<Item = &[u8]> {
    content
        .split(|&byte| !token_byte(byte))
        .filter(|token| !token.is_empty())
}

/// Which files contain a term as a substring, answered from the files' distinct
/// tokens. A term made only of token bytes occurs in a file exactly when it occurs
/// inside one of the file's tokens, so the answer equals a full-content search.
/// Other terms (empty, or containing separators such as `-`) fall back to scanning.
pub(crate) struct TokenIndex<'a> {
    contents: Vec<&'a [u8]>,
    // Distinct tokens joined by '\n' (never a token byte), with each token's start.
    vocabulary: Vec<u8>,
    starts: Vec<usize>,
    // For each token, the ascending ids of the files containing it.
    postings: Vec<Vec<u32>>,
    memo: HashMap<String, Rc<Vec<u32>>>,
    // False when `stop` ended indexing early; answers would miss files.
    complete: bool,
}
impl<'a> TokenIndex<'a> {
    /// Indexes `contents` until `stop` is true (checked between files).
    pub(crate) fn new(contents: Vec<&'a [u8]>, stop: &dyn Fn() -> bool) -> Self {
        let mut ids = HashMap::<&'a [u8], usize>::new();
        let mut vocabulary = Vec::new();
        let mut starts = Vec::new();
        let mut postings: Vec<Vec<u32>> = Vec::new();
        let mut complete = true;
        for (file, content) in contents.iter().enumerate() {
            if stop() {
                complete = false;
                break;
            }
            for token in tokens(content) {
                let id = *ids.entry(token).or_insert_with(|| {
                    starts.push(vocabulary.len());
                    vocabulary.extend_from_slice(token);
                    vocabulary.push(b'\n');
                    postings.push(Vec::new());
                    postings.len() - 1
                });
                if postings[id].last() != Some(&(file as u32)) {
                    postings[id].push(file as u32);
                }
            }
        }
        Self {
            contents,
            vocabulary,
            starts,
            postings,
            memo: HashMap::new(),
            complete,
        }
    }
    pub(crate) fn complete(&self) -> bool {
        self.complete
    }
    /// Ascending ids of the files whose content contains `term`.
    pub(crate) fn files(&mut self, term: &str) -> Result<Rc<Vec<u32>>> {
        if let Some(files) = self.memo.get(term) {
            return Ok(files.clone());
        }
        let bytes = term.as_bytes();
        let files = if bytes.is_empty() {
            (0..self.contents.len() as u32).collect()
        } else if bytes.iter().all(|&byte| token_byte(byte)) {
            let search = AhoCorasick::new([bytes])?;
            let mut matched = vec![false; self.postings.len()];
            for found in search.find_overlapping_iter(&self.vocabulary) {
                let token = self.starts.partition_point(|&start| start <= found.start()) - 1;
                matched[token] = true;
            }
            let mut files: Vec<u32> = matched
                .iter()
                .enumerate()
                .filter(|(_, hit)| **hit)
                .flat_map(|(token, _)| self.postings[token].iter().copied())
                .collect();
            files.sort_unstable();
            files.dedup();
            files
        } else {
            let search = AhoCorasick::new([bytes])?;
            (0..self.contents.len() as u32)
                .filter(|&file| search.is_match(self.contents[file as usize]))
                .collect()
        };
        let files = Rc::new(files);
        self.memo.insert(term.into(), files.clone());
        Ok(files)
    }
    /// Ascending ids of the files containing any of the terms.
    pub(crate) fn any(&mut self, terms: &[&str]) -> Result<Vec<u32>> {
        let mut files = Vec::new();
        for term in terms {
            files.extend(self.files(term)?.iter().copied());
        }
        files.sort_unstable();
        files.dedup();
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn naive(contents: &[&[u8]], term: &str) -> Vec<u32> {
        (0..contents.len() as u32)
            .filter(|&i| {
                term.is_empty()
                    || contents[i as usize]
                        .windows(term.len())
                        .any(|window| window == term.as_bytes())
            })
            .collect()
    }
    #[test]
    fn token_rules_match_a_full_content_search() {
        let contents: Vec<&[u8]> = vec![
            b"fn parse_args() { myargs(); }",
            b"use crate::args::Args;",
            b"const $el = $('x'); // jQuery",
            "def nai\u{308}ve(): return \u{fc}ber_args".as_bytes(),
            b"import './my-mod';",
            b"no match here",
            b"",
        ];
        let mut index = TokenIndex::new(contents.clone(), &|| false);
        for term in [
            "args",
            "Args",
            "myargs",
            "parse",
            "$el",
            "$",
            "\u{fc}ber",
            "ve",
            "my-mod",
            "my",
            "",
            "match here",
            "zzz",
        ] {
            assert_eq!(
                *index.files(term).unwrap(),
                naive(&contents, term),
                "term {term:?}"
            );
        }
        assert_eq!(index.any(&["Args", "jQuery"]).unwrap(), vec![1, 2]);
    }
}
