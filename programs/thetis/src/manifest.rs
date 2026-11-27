//! The shipment manifest: a 16-leaf SHA-256 Merkle tree over the batches, whose root the owner
//! signs at prepare. Leaves past the batch count are 32 zero bytes, unhashed; the program never
//! checks the padding, because an index at or past the batch count is refused.

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

/// The tree's depth: 16 leaves.
pub const DEPTH: usize = 4;

const LEAF_PREFIX: [u8; 1] = [0x00];
const NODE_PREFIX: [u8; 1] = [0x01];

/// SHA-256 of `0x00 ‖ index ‖ quantity_kg (u64 LE) ‖ carrier ‖ load_digest ‖ manifest_digest`.
pub fn batch_leaf(
    index: u8,
    quantity_kg: u64,
    carrier: &Pubkey,
    load_digest: &[u8; 32],
    manifest_digest: &[u8; 32],
) -> [u8; 32] {
    hashv(&[
        &LEAF_PREFIX,
        &[index],
        &quantity_kg.to_le_bytes(),
        carrier.as_ref(),
        load_digest,
        manifest_digest,
    ])
    .to_bytes()
}

/// SHA-256 of `0x01 ‖ left ‖ right`.
pub fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[&NODE_PREFIX, left, right]).to_bytes()
}

/// Whether `leaf` at `index` hashes up to `root` with `proof`, the siblings from the leaf level
/// upwards: bit `l` of `index` says whether the running hash is the left (0) or right (1) child.
pub fn verify_batch(root: &[u8; 32], index: u8, leaf: [u8; 32], proof: &[[u8; 32]; DEPTH]) -> bool {
    let mut current = leaf;
    for (level, sibling) in proof.iter().enumerate() {
        current = if (index >> level) & 1 == 0 {
            node(&current, sibling)
        } else {
            node(sibling, &current)
        };
    }
    current == *root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leaf_and_a_node_are_domain_separated() {
        let zero = [0; 32];
        assert_ne!(node(&zero, &zero), hashv(&[&zero, &zero]).to_bytes());
        let leaf = batch_leaf(0, 1, &Pubkey::default(), &zero, &zero);
        assert_ne!(leaf, node(&zero, &zero));
    }

    #[test]
    fn index_bits_above_the_depth_change_nothing_below_it() {
        let leaf = batch_leaf(0, 1, &Pubkey::default(), &[1; 32], &[2; 32]);
        let proof = [[3; 32], [4; 32], [5; 32], [6; 32]];
        let mut root = leaf;
        for sibling in &proof {
            root = node(&root, sibling);
        }
        assert!(verify_batch(&root, 0, leaf, &proof));
        assert!(verify_batch(&root, 16, leaf, &proof));
        assert!(!verify_batch(&root, 1, leaf, &proof));
    }
}
