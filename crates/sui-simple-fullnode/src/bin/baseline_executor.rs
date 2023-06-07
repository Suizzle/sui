use clap::*;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;
use sui_adapter::execution_engine;
use sui_adapter::execution_mode;
use sui_config::{Config, NodeConfig};
use sui_core::authority::epoch_start_configuration::EpochStartConfiguration;
use sui_core::transaction_input_checker::get_gas_status_no_epoch_store_experimental;
use sui_simple_fullnode::MemoryBackedStore;
use sui_simple_fullnode::SequenceWorkerState;
use sui_types::message_envelope::Message;
use sui_types::messages::InputObjectKind;
use sui_types::messages::InputObjects;
use sui_types::messages::TransactionDataAPI;
use sui_types::messages::TransactionKind;
use sui_types::multiaddr::Multiaddr;
use sui_types::sui_system_state::epoch_start_sui_system_state::EpochStartSystemStateTrait;
use sui_types::sui_system_state::get_sui_system_state;
use sui_types::sui_system_state::SuiSystemStateTrait;
use sui_types::temporary_store::TemporaryStore;

const GIT_REVISION: &str = {
    if let Some(revision) = option_env!("GIT_REVISION") {
        revision
    } else {
        let version = git_version::git_version!(
            args = ["--always", "--dirty", "--exclude", "*"],
            fallback = ""
        );

        if version.is_empty() {
            panic!("unable to query git revision");
        }
        version
    }
};
const VERSION: &str = const_str::concat!(env!("CARGO_PKG_VERSION"), "-", GIT_REVISION);

#[derive(Parser)]
#[clap(rename_all = "kebab-case")]
#[clap(name = env!("CARGO_BIN_NAME"))]
#[clap(version = VERSION)]
struct Args {
    #[clap(long)]
    pub config_path: PathBuf,

    /// Specifies the watermark up to which I will download checkpoints
    #[clap(long)]
    download: Option<u64>,

    /// Specifies whether I will execute or not
    #[clap(long)]
    execute: bool,

    #[clap(long, help = "Specify address to listen on")]
    listen_address: Option<Multiaddr>,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let config = NodeConfig::load(&args.config_path).unwrap();
    let genesis = config.genesis().expect("Could not load genesis");
    let mut sw_state = SequenceWorkerState::new(&config).await;

    if let Some(watermark) = args.download {
        sw_state.handle_download(watermark, &config).await;
    }

    if args.execute {
        let mut memory_store = MemoryBackedStore::new();
        for obj in genesis.objects() {
            memory_store
                .objects
                .insert(obj.id(), (obj.compute_object_reference(), obj.clone()));
        }

        let mut protocol_config = sw_state.epoch_store.protocol_config();
        let mut move_vm = sw_state.epoch_store.move_vm();
        let mut epoch_start_config = sw_state.epoch_store.epoch_start_config();
        let mut reference_gas_price = sw_state.epoch_store.reference_gas_price();

        let genesis_seq = genesis.checkpoint().into_summary_and_sequence().0;

        let highest_synced_seq = match sw_state
            .checkpoint_store
            .get_highest_synced_checkpoint_seq_number()
            .expect("error")
        {
            Some(highest) => highest,
            None => 0,
        };
        let highest_executed_seq = match sw_state
            .checkpoint_store
            .get_highest_executed_checkpoint_seq_number()
            .expect("error")
        {
            Some(highest) => highest,
            None => 0,
        };
        println!("Highest synced {}", highest_synced_seq);
        println!("Highest executed {}", highest_executed_seq);

        let now = Instant::now();
        let mut num_tx: usize = 0;
        for checkpoint_seq in genesis_seq..highest_synced_seq {
            let checkpoint_summary = sw_state
                .checkpoint_store
                .get_checkpoint_by_sequence_number(checkpoint_seq)
                .expect("Cannot get checkpoint")
                .expect("Checkpoint is None");

            if checkpoint_seq % 1000 == 0 {
                println!("{}", checkpoint_seq);
            }

            let (_seq, summary) = checkpoint_summary.into_summary_and_sequence();
            let contents = sw_state
                .checkpoint_store
                .get_checkpoint_contents(&summary.content_digest)
                .expect("Contents must exist")
                .expect("Contents must exist");
            num_tx += contents.size();
            for tx_digest in contents.iter() {
                let tx = sw_state
                    .store
                    .get_transaction_block(&tx_digest.transaction)
                    .expect("Transaction exists")
                    .expect("Transaction exists");
                let tx_data = tx.data().transaction_data();
                let input_object_kinds = tx_data
                    .input_objects()
                    .expect("Cannot get input object kinds");
                // println!("Digest: {:?}", tx_digest);

                let mut input_object_data = Vec::new();
                for kind in &input_object_kinds {
                    let obj = match kind {
                        InputObjectKind::MovePackage(id)
                        | InputObjectKind::SharedMoveObject { id, .. }
                        | InputObjectKind::ImmOrOwnedMoveObject((id, _, _)) => {
                            memory_store.objects.get(&id).expect("Object missing?")
                        }
                    };
                    input_object_data.push(obj.1.clone());
                }

                let gas_status = get_gas_status_no_epoch_store_experimental(
                    &input_object_data,
                    tx_data.gas(),
                    protocol_config,
                    reference_gas_price,
                    &tx_data,
                )
                .await
                .expect("Could not get gas");

                let input_objects = InputObjects::new(
                    input_object_kinds
                        .into_iter()
                        .zip(input_object_data.into_iter())
                        .collect(),
                );
                let shared_object_refs = input_objects.filter_shared_objects();
                let transaction_dependencies = input_objects.transaction_dependencies();

                let temporary_store = TemporaryStore::new(
                    &memory_store,
                    input_objects,
                    *tx.digest(),
                    protocol_config,
                );

                let (kind, signer, gas) = tx_data.execution_parts();

                if let TransactionKind::ChangeEpoch(_) = kind {
                    println!("Change epoch at checkpoint {}", checkpoint_seq)
                    // check if this is the last transaction of the epoch
                }

                let (inner_temp_store, effects, _execution_error) =
                    execution_engine::execute_transaction_to_effects::<execution_mode::Normal, _>(
                        shared_object_refs,
                        temporary_store,
                        kind,
                        signer,
                        &gas,
                        *tx.digest(),
                        transaction_dependencies,
                        move_vm,
                        gas_status,
                        &epoch_start_config.epoch_data(),
                        protocol_config,
                        sw_state.metrics.clone(),
                        false,
                        &HashSet::new(),
                    );

                // Critical check: are the effects the same?
                if effects.digest() != tx_digest.effects {
                    println!("Effects mismatch at checkpoint {}", checkpoint_seq);
                    let old_effects = tx_digest.effects;
                    println!("Past effects: {:?}", old_effects);
                    println!("New effects: {:?}", effects);
                }
                assert!(
                    effects.digest() == tx_digest.effects,
                    "Effects digest mismatch"
                );

                // And now we mutate the store.
                // First delete:
                for obj_del in &inner_temp_store.deleted {
                    memory_store.objects.remove(obj_del.0);
                }
                for (obj_add_id, (oref, obj, _)) in inner_temp_store.written {
                    memory_store.objects.insert(obj_add_id, (oref, obj));
                }
            }

            if summary.end_of_epoch_data.is_some() {
                println!("END OF EPOCH at checkpoint {}", checkpoint_seq);
                let latest_state = get_sui_system_state(&&memory_store)
                    .expect("Read Sui System State object cannot fail");
                let new_epoch_start_state = latest_state.into_epoch_start_state();
                let next_epoch_committee = new_epoch_start_state.get_sui_committee();
                let next_epoch = next_epoch_committee.epoch();
                let last_checkpoint = sw_state
                    .checkpoint_store
                    .get_epoch_last_checkpoint(sw_state.epoch_store.epoch())
                    .expect("Error loading last checkpoint for current epoch")
                    .expect("Could not load last checkpoint for current epoch");
                println!(
                    "Last checkpoint sequence number: {}",
                    last_checkpoint.sequence_number(),
                );
                let epoch_start_configuration =
                    EpochStartConfiguration::new(new_epoch_start_state, *last_checkpoint.digest());
                assert_eq!(sw_state.epoch_store.epoch() + 1, next_epoch);
                sw_state.epoch_store = sw_state.epoch_store.new_at_next_epoch(
                    config.protocol_public_key(),
                    next_epoch_committee,
                    epoch_start_configuration,
                    sw_state.store.clone(),
                    &config.expensive_safety_check_config,
                );
                println!("New epoch store has epoch {}", sw_state.epoch_store.epoch());
                protocol_config = sw_state.epoch_store.protocol_config();
                move_vm = sw_state.epoch_store.move_vm();
                epoch_start_config = sw_state.epoch_store.epoch_start_config();
                reference_gas_price = sw_state.epoch_store.reference_gas_price();
            }
        } // for loop over checkpoints

        // print TPS
        let elapsed = now.elapsed();
        println!(
            "TPS: {}",
            1000.0 * num_tx as f64 / elapsed.as_millis() as f64
        );
    } // if args.execute
}